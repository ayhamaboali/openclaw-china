/**
 * 飞书 WebSocket 连接管理
 */

import * as lark from "@larksuiteoapi/node-sdk";
import type { FeishuConfig } from "./config.js";
import type { FeishuMessageEvent } from "./types.js";
import { createLogger, type Logger } from "./logger.js";
import { handleFeishuMessage } from "./bot.js";

/**
 * Gateway 配置选项
 */
export interface FeishuGatewayOptions {
  config?: {
    channels?: {
      "feishu-china"?: FeishuConfig;
    };
  };
  runtime?: {
    log?: (msg: string) => void;
    error?: (msg: string) => void;
  };
  abortSignal?: AbortSignal;
  accountId?: string;
}

// WebSocket 客户端缓存
let currentClient: lark.WSClient | null = null;
let currentAccountId: string | null = null;
let currentPromise: Promise<void> | null = null;
let currentStop: (() => void) | null = null;

// 消息去重缓存 (messageId -> timestamp)
const processedMessages = new Map<string, number>();
const MESSAGE_DEDUPE_TTL_MS = 60 * 1000; // 60秒过期

// 消息过期时间（30分钟）
const MESSAGE_EXPIRE_TTL_MS = 30 * 60 * 1000;

// 连接健康检查
const WATCHDOG_INTERVAL_MS = 10000;
const CONNECT_GRACE_MS = 30000;
const MIN_RECONNECT_INTERVAL_MS = 10000;

type FeishuWsInstance = {
  readyState?: number;
  terminate?: () => void;
};

type FeishuWsClientInternal = {
  wsConfig?: { getWSInstance?: () => FeishuWsInstance | null };
  reConnect?: (isStart?: boolean) => void;
};

function cleanupDedupeCache(): void {
  const now = Date.now();
  for (const [messageId, timestamp] of processedMessages) {
    if (now - timestamp > MESSAGE_DEDUPE_TTL_MS) {
      processedMessages.delete(messageId);
    }
  }
}

function isDuplicateMessage(messageId: string): boolean {
  if (!messageId) return false;
  if (processedMessages.has(messageId)) {
    return true;
  }
  processedMessages.set(messageId, Date.now());
  if (processedMessages.size > 100) {
    cleanupDedupeCache();
  }
  return false;
}

function isMessageExpired(createTimeMs: string | undefined): boolean {
  if (!createTimeMs) return false;
  const createTime = Number.parseInt(createTimeMs, 10);
  if (Number.isNaN(createTime)) return false;
  const now = Date.now();
  return now - createTime > MESSAGE_EXPIRE_TTL_MS;
}

/**
 * 启动飞书 WebSocket 连接
 */
export async function startFeishuGateway(opts: FeishuGatewayOptions = {}): Promise<void> {
  const { config, runtime, abortSignal, accountId = "default" } = opts;

  const logger: Logger = createLogger("feishu", {
    log: runtime?.log,
    error: runtime?.error,
  });

  if (currentClient) {
    if (currentAccountId && currentAccountId !== accountId) {
      throw new Error(`Feishu already running for account ${currentAccountId}`);
    }
    logger.debug(`existing connection for account ${accountId} is active, reusing gateway`);
    if (currentPromise) {
      return currentPromise;
    }
    throw new Error("Feishu gateway state invalid: active client without promise");
  }

  const feishuCfg = config?.channels?.["feishu-china"];
  if (!feishuCfg) {
    throw new Error("Feishu configuration not found");
  }

  if (!feishuCfg.appId || !feishuCfg.appSecret) {
    throw new Error("Feishu appId/appSecret missing");
  }

  const wsClient = new lark.WSClient({
    appId: feishuCfg.appId,
    appSecret: feishuCfg.appSecret,
    loggerLevel: lark.LoggerLevel.error,
  });

  currentClient = wsClient;
  currentAccountId = accountId;

  logger.info(`starting WebSocket connection for account ${accountId}...`);

  currentPromise = new Promise<void>((resolve, reject) => {
    let stopped = false;
    let watchdogId: ReturnType<typeof setInterval> | null = null;
    let connectStartedAt = Date.now();
    let lastOpenAt: number | null = null;
    let lastReconnectAt = 0;

    const getWsInstance = (): FeishuWsInstance | null => {
      const clientAny = wsClient as unknown as FeishuWsClientInternal;
      return clientAny.wsConfig?.getWSInstance?.() ?? null;
    };

    const forceReconnect = (reason: string) => {
      const now = Date.now();
      if (now - lastReconnectAt < MIN_RECONNECT_INTERVAL_MS) {
        return;
      }
      lastReconnectAt = now;
      logger.warn(`[gateway] forcing reconnect: ${reason}`);
      try {
        const clientAny = wsClient as unknown as FeishuWsClientInternal;
        if (typeof clientAny.reConnect === "function") {
          clientAny.reConnect(true);
          return;
        }
        getWsInstance()?.terminate?.();
      } catch (err) {
        logger.error(`failed to force reconnect: ${String(err)}`);
      }
    };

    const cleanup = () => {
      if (watchdogId) {
        clearInterval(watchdogId);
        watchdogId = null;
      }
      if (currentClient === wsClient) {
        currentClient = null;
        currentAccountId = null;
        currentStop = null;
        currentPromise = null;
      }
      try {
        const clientAny = wsClient as unknown as Record<string, unknown>;
        if (typeof clientAny.close === "function") {
          (clientAny.close as () => void)();
        } else if (typeof clientAny.stop === "function") {
          (clientAny.stop as () => void)();
        }
      } catch (err) {
        logger.error(`failed to stop client: ${String(err)}`);
      }
    };

    const finalizeResolve = () => {
      if (stopped) return;
      stopped = true;
      abortSignal?.removeEventListener("abort", handleAbort);
      cleanup();
      resolve();
    };

    const finalizeReject = (err: unknown) => {
      if (stopped) return;
      stopped = true;
      abortSignal?.removeEventListener("abort", handleAbort);
      cleanup();
      reject(err);
    };

    const handleAbort = () => {
      logger.info("abort signal received, stopping gateway");
      finalizeResolve();
    };

    currentStop = () => {
      logger.info("stop requested, stopping gateway");
      finalizeResolve();
    };

    if (abortSignal?.aborted) {
      finalizeResolve();
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    try {
      const eventDispatcher = new lark.EventDispatcher({}).register({
        "im.message.receive_v1": async (data: unknown) => {
          const event = data as FeishuMessageEvent;
          const message = event.message;
          if (!message) return {};

          const messageId = message.message_id ?? "";

          if (isDuplicateMessage(messageId)) {
            return {};
          }

          if (isMessageExpired(message.create_time)) {
            logger.info(`skipping expired message ${messageId}`);
            return {};
          }

          const contentPreview = message.content ? message.content.slice(0, 80) : "";
          logger.info(
            `Inbound: chat=${message.chat_id ?? ""} type=${message.message_type ?? ""} text="${contentPreview}"`,
          );

          setImmediate(() => {
            void handleFeishuMessage({
              cfg: config,
              event,
              accountId,
              log: (msg: string) => logger.info(msg.replace(/^\[feishu\]\s*/, "")),
              error: (msg: string) => logger.error(msg.replace(/^\[feishu\]\s*/, "")),
            }).catch((err) => {
              logger.error(`error handling message: ${String(err)}`);
            });
          });

          return {};
        },
      });

      wsClient.start({
        eventDispatcher,
      });

      // Start watchdog to detect stalled connections.
      connectStartedAt = Date.now();
      lastOpenAt = null;
      watchdogId = setInterval(() => {
        if (stopped) return;
        const wsInstance = getWsInstance();
        const readyState = wsInstance?.readyState;
        if (readyState === 1) {
          lastOpenAt = Date.now();
          return;
        }

        const lastSeen = lastOpenAt ?? connectStartedAt;
        if (Date.now() - lastSeen > CONNECT_GRACE_MS) {
          forceReconnect("ws not open");
          connectStartedAt = Date.now();
          lastOpenAt = null;
        }
      }, WATCHDOG_INTERVAL_MS);

      logger.info("WebSocket client start invoked");
    } catch (err) {
      logger.error(`failed to start WebSocket connection: ${String(err)}`);
      finalizeReject(err);
    }
  });

  return currentPromise;
}

/**
 * 停止飞书 Gateway
 */
export function stopFeishuGateway(accountId = "default"): void {
  if (currentStop) {
    if (!currentAccountId || currentAccountId === accountId) {
      currentStop();
    }
    return;
  }

  if (currentClient) {
    try {
      const clientAny = currentClient as unknown as Record<string, unknown>;
      if (typeof clientAny.close === "function") {
        (clientAny.close as () => void)();
      } else if (typeof clientAny.stop === "function") {
        (clientAny.stop as () => void)();
      }
    } catch (err) {
      console.error(`[feishu] failed to stop client: ${String(err)}`);
    } finally {
      currentClient = null;
      currentAccountId = null;
      currentPromise = null;
      currentStop = null;
    }
  }
}

/**
 * 获取当前连接状态
 */
export function isGatewayActive(): boolean {
  return currentClient !== null;
}
