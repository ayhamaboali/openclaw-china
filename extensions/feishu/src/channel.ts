/**
 * 飞书 ChannelPlugin 实现
 */

import type { ResolvedFeishuAccount, FeishuConfig } from "./types.js";
import { FeishuConfigSchema, isConfigured, resolveFeishuCredentials } from "./config.js";
import { feishuOutbound } from "./outbound.js";
import { startFeishuGateway, stopFeishuGateway } from "./gateway.js";
import { setFeishuRuntime } from "./runtime.js";

/** 默认账户 ID */
export const DEFAULT_ACCOUNT_ID = "default";

const meta = {
  id: "feishu-china",
  label: "Feishu",
  selectionLabel: "Feishu/Lark (飞书)",
  docsPath: "/channels/feishu-china",
  docsLabel: "feishu-china",
  blurb: "飞书/Lark 企业消息",
  aliases: ["lark"],
  order: 70,
} as const;

interface PluginConfig {
  channels?: {
    "feishu-china"?: FeishuConfig;
  };
}

function resolveFeishuAccount(params: {
  cfg: PluginConfig;
  accountId?: string;
}): ResolvedFeishuAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;
  const feishuCfg = cfg.channels?.["feishu-china"];

  const parsed = feishuCfg ? FeishuConfigSchema.safeParse(feishuCfg) : null;
  const config = parsed?.success ? parsed.data : undefined;

  const credentials = resolveFeishuCredentials(config);
  const configured = Boolean(credentials);

  return {
    accountId,
    enabled: config?.enabled ?? true,
    configured,
    appId: credentials?.appId,
  };
}

export const feishuPlugin = {
  id: "feishu-china",

  meta: {
    ...meta,
  },

  capabilities: {
    chatTypes: ["direct", "channel"] as const,
    media: true,
    reactions: false,
    threads: false,
    edit: false,
    reply: true,
    polls: false,
  },

  configSchema: {
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        enabled: { type: "boolean" },
        appId: { type: "string" },
        appSecret: { type: "string" },
        connectionMode: { type: "string", enum: ["websocket"] },
        dmPolicy: { type: "string", enum: ["open", "pairing", "allowlist"] },
        groupPolicy: { type: "string", enum: ["open", "allowlist", "disabled"] },
        requireMention: { type: "boolean" },
        allowFrom: { type: "array", items: { type: "string" } },
        groupAllowFrom: { type: "array", items: { type: "string" } },
        sendMarkdownAsCard: { type: "boolean" },
        historyLimit: { type: "integer", minimum: 0 },
        textChunkLimit: { type: "integer", minimum: 1 },
      },
    },
  },

  reload: { configPrefixes: ["channels.feishu-china"] },

  config: {
    listAccountIds: (_cfg: PluginConfig): string[] => [DEFAULT_ACCOUNT_ID],

    resolveAccount: (cfg: PluginConfig, accountId?: string): ResolvedFeishuAccount =>
      resolveFeishuAccount({ cfg, accountId }),

    defaultAccountId: (): string => DEFAULT_ACCOUNT_ID,

    setAccountEnabled: (params: { cfg: PluginConfig; enabled: boolean }): PluginConfig => {
      const existingConfig = params.cfg.channels?.["feishu-china"] ?? {};
      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          "feishu-china": {
            ...existingConfig,
            enabled: params.enabled,
          } as FeishuConfig,
        },
      };
    },

    deleteAccount: (params: { cfg: PluginConfig }): PluginConfig => {
      const next = { ...params.cfg };
      const nextChannels = { ...params.cfg.channels };
      delete (nextChannels as Record<string, unknown>)["feishu-china"];
      if (Object.keys(nextChannels).length > 0) {
        next.channels = nextChannels;
      } else {
        delete next.channels;
      }
      return next;
    },

    isConfigured: (_account: ResolvedFeishuAccount, cfg: PluginConfig): boolean =>
      isConfigured(cfg.channels?.["feishu-china"]),

    describeAccount: (account: ResolvedFeishuAccount) => ({
      accountId: account.accountId,
      enabled: account.enabled,
      configured: account.configured,
    }),

    resolveAllowFrom: (params: { cfg: PluginConfig }): string[] =>
      params.cfg.channels?.["feishu-china"]?.allowFrom ?? [],

    formatAllowFrom: (params: { allowFrom: (string | number)[] }): string[] =>
      params.allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.toLowerCase()),
  },

  security: {
    collectWarnings: (params: { cfg: PluginConfig }): string[] => {
      const feishuCfg = params.cfg.channels?.["feishu-china"];
      const groupPolicy = feishuCfg?.groupPolicy ?? "allowlist";
      if (groupPolicy !== "open") return [];
      return [
        `- Feishu groups: groupPolicy="open" allows any member to trigger (mention-gated). Set channels.feishu-china.groupPolicy="allowlist" + channels.feishu-china.groupAllowFrom to restrict senders.`,
      ];
    },
  },

  setup: {
    resolveAccountId: (): string => DEFAULT_ACCOUNT_ID,
    applyAccountConfig: (params: { cfg: PluginConfig }): PluginConfig => {
      const existingConfig = params.cfg.channels?.["feishu-china"] ?? {};
      return {
        ...params.cfg,
        channels: {
          ...params.cfg.channels,
          "feishu-china": {
            ...existingConfig,
            enabled: true,
          } as FeishuConfig,
        },
      };
    },
  },

  outbound: feishuOutbound,

  gateway: {
    startAccount: async (ctx: {
      cfg: PluginConfig;
      runtime?: unknown;
      abortSignal?: AbortSignal;
      accountId: string;
      setStatus?: (status: Record<string, unknown>) => void;
      log?: { info: (msg: string) => void; error: (msg: string) => void };
    }): Promise<void> => {
      ctx.setStatus?.({ accountId: ctx.accountId });
      ctx.log?.info(`[feishu] starting gateway for account ${ctx.accountId}`);

      if (ctx.runtime) {
        const candidate = ctx.runtime as {
          channel?: {
            routing?: { resolveAgentRoute?: unknown };
            reply?: { dispatchReplyFromConfig?: unknown };
          };
        };
        if (
          candidate.channel?.routing?.resolveAgentRoute &&
          candidate.channel?.reply?.dispatchReplyFromConfig
        ) {
          setFeishuRuntime(ctx.runtime as Record<string, unknown>);
        }
      }

      await startFeishuGateway({
        config: ctx.cfg,
        runtime:
          (ctx.runtime as { log?: (msg: string) => void; error?: (msg: string) => void }) ?? {
            log: ctx.log?.info ?? console.log,
            error: ctx.log?.error ?? console.error,
          },
        abortSignal: ctx.abortSignal,
        accountId: ctx.accountId,
      });
    },
    stopAccount: async (ctx: { accountId: string }): Promise<void> => {
      stopFeishuGateway(ctx.accountId);
    },
    getStatus: () => ({ connected: true }),
  },
};
