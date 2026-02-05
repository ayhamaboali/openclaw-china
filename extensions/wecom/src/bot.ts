/**
 * 企业微信消息处理
 *
 * 按参考实现的 session/envelope + buffered dispatcher 方式分发
 */

import {
  checkDmPolicy,
  checkGroupPolicy,
  createLogger,
  type Logger,
  resolveExtension,
} from "@openclaw-china/shared";

import type { PluginRuntime } from "./runtime.js";
import type { ResolvedWecomAccount, WecomInboundMessage, WecomDmPolicy } from "./types.js";
import { decryptWecomMedia } from "./crypto.js";
import * as os from "os";
import * as path from "path";
import * as fsPromises from "fs/promises";
import {
  resolveAllowFrom,
  resolveGroupAllowFrom,
  resolveGroupPolicy,
  resolveRequireMention,
  type PluginConfig,
} from "./config.js";

export type WecomDispatchHooks = {
  onChunk: (text: string) => void;
  onError?: (err: unknown) => void;
};

export function extractWecomContent(msg: WecomInboundMessage): string {
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  if (msgtype === "text") {
    const content = (msg as { text?: { content?: string } }).text?.content;
    return typeof content === "string" ? content : "";
  }
  if (msgtype === "voice") {
    const content = (msg as { voice?: { content?: string } }).voice?.content;
    return typeof content === "string" ? content : "[voice]";
  }
  if (msgtype === "mixed") {
    const items = (msg as { mixed?: { msg_item?: unknown } }).mixed?.msg_item;
    if (Array.isArray(items)) {
      return items
        .map((item: unknown) => {
          if (!item || typeof item !== "object") return "";
          const typed = item as { msgtype?: string; text?: { content?: string }; image?: { url?: string } };
          const t = String(typed.msgtype ?? "").toLowerCase();
          if (t === "text") return String(typed.text?.content ?? "");
          if (t === "image") return `[image] ${String(typed.image?.url ?? "").trim()}`.trim();
          return t ? `[${t}]` : "";
        })
        .filter((part) => Boolean(part && part.trim()))
        .join("\n");
    }
    return "[mixed]";
  }
  if (msgtype === "image") {
    const url = String((msg as { image?: { url?: string } }).image?.url ?? "").trim();
    return url ? `[image] ${url}` : "[image]";
  }
  if (msgtype === "file") {
    const url = String((msg as { file?: { url?: string } }).file?.url ?? "").trim();
    return url ? `[file] ${url}` : "[file]";
  }
  if (msgtype === "event") {
    const eventtype = String((msg as { event?: { eventtype?: string } }).event?.eventtype ?? "").trim();
    return eventtype ? `[event] ${eventtype}` : "[event]";
  }
  if (msgtype === "stream") {
    const id = String((msg as { stream?: { id?: string } }).stream?.id ?? "").trim();
    return id ? `[stream_refresh] ${id}` : "[stream_refresh]";
  }
  return msgtype ? `[${msgtype}]` : "";
}

function resolveSenderId(msg: WecomInboundMessage): string {
  const userid = msg.from?.userid?.trim();
  return userid || "unknown";
}

function resolveChatType(msg: WecomInboundMessage): "direct" | "group" {
  return msg.chattype === "group" ? "group" : "direct";
}

function resolveChatId(msg: WecomInboundMessage, senderId: string, chatType: "direct" | "group"): string {
  if (chatType === "group") {
    return msg.chatid?.trim() || "unknown";
  }
  return senderId;
}

function buildInboundBody(msg: WecomInboundMessage): string {
  const msgtype = String(msg.msgtype ?? "").toLowerCase();
  if (msgtype === "text") {
    const content = (msg as { text?: { content?: string } }).text?.content;
    return typeof content === "string" ? content : "";
  }
  if (msgtype === "voice") {
    const content = (msg as { voice?: { content?: string } }).voice?.content;
    return typeof content === "string" ? content : "[voice]";
  }
  if (msgtype === "mixed") {
    const items = (msg as { mixed?: { msg_item?: unknown } }).mixed?.msg_item;
    if (Array.isArray(items)) {
      return items
        .map((item: unknown) => {
          if (!item || typeof item !== "object") return "";
          const typed = item as { msgtype?: string; text?: { content?: string }; image?: { url?: string } };
          const t = String(typed.msgtype ?? "").toLowerCase();
          if (t === "text") return String(typed.text?.content ?? "");
          if (t === "image") return `[image] ${String(typed.image?.url ?? "").trim()}`.trim();
          return t ? `[${t}]` : "";
        })
        .filter((part) => Boolean(part && part.trim()))
        .join("\n");
    }
    return "[mixed]";
  }
  if (msgtype === "image") {
    const url = String((msg as { image?: { url?: string } }).image?.url ?? "").trim();
    return url ? `[image] ${url}` : "[image]";
  }
  if (msgtype === "file") {
    const url = String((msg as { file?: { url?: string } }).file?.url ?? "").trim();
    return url ? `[file] ${url}` : "[file]";
  }
  if (msgtype === "event") {
    const eventtype = String((msg as { event?: { eventtype?: string } }).event?.eventtype ?? "").trim();
    return eventtype ? `[event] ${eventtype}` : "[event]";
  }
  if (msgtype === "stream") {
    const id = String((msg as { stream?: { id?: string } }).stream?.id ?? "").trim();
    return id ? `[stream_refresh] ${id}` : "[stream_refresh]";
  }
  return msgtype ? `[${msgtype}]` : "";
}

export async function dispatchWecomMessage(params: {
  cfg?: PluginConfig;
  account: ResolvedWecomAccount;
  msg: WecomInboundMessage;
  core: PluginRuntime;
  hooks: WecomDispatchHooks;
  log?: (msg: string) => void;
  error?: (msg: string) => void;
}): Promise<void> {
  const { cfg, account, msg, core, hooks } = params;
  const safeCfg = (cfg ?? {}) as PluginConfig;

  const logger: Logger = createLogger("wecom", { log: params.log, error: params.error });

  const chatType = resolveChatType(msg);
  const senderId = resolveSenderId(msg);
  const chatId = resolveChatId(msg, senderId, chatType);

  const accountConfig = account?.config ?? {};

  if (chatType === "group") {
    const groupPolicy = resolveGroupPolicy(accountConfig);
    const groupAllowFrom = resolveGroupAllowFrom(accountConfig);
    const requireMention = resolveRequireMention(accountConfig);

    const policyResult = checkGroupPolicy({
      groupPolicy,
      conversationId: chatId,
      groupAllowFrom,
      requireMention,
      mentionedBot: true,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  } else {
    const dmPolicyRaw: WecomDmPolicy = accountConfig.dmPolicy ?? "pairing";
    if (dmPolicyRaw === "disabled") {
      logger.debug("dmPolicy=disabled, skipping dispatch");
      return;
    }

    const allowFrom = resolveAllowFrom(accountConfig);
    const policyResult = checkDmPolicy({
      dmPolicy: dmPolicyRaw,
      senderId,
      allowFrom,
    });

    if (!policyResult.allowed) {
      logger.debug(`policy rejected: ${policyResult.reason}`);
      return;
    }
  }

  const channel = core.channel;
  if (!channel?.routing?.resolveAgentRoute || !channel.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    logger.debug("core routing or buffered dispatcher missing, skipping dispatch");
    return;
  }

  const route = channel.routing.resolveAgentRoute({
    cfg: safeCfg,
    channel: "wecom",
    peer: { kind: chatType === "group" ? "group" : "dm", id: chatId },
  });

  // 处理媒体文件（下载和解密）
  const mediaResult = await processMediaInMessage({
    msg,
    encodingAESKey: account.encodingAESKey,
    log: logger,
  });

  const rawBody = mediaResult.text;
  const fromLabel = chatType === "group" ? `group:${chatId}` : `user:${senderId}`;

  try {
    const storePath = channel.session?.resolveStorePath?.(safeCfg.session?.store, {
      agentId: route.agentId,
    });

    const previousTimestamp = channel.session?.readSessionUpdatedAt
      ? channel.session.readSessionUpdatedAt({
          storePath,
          sessionKey: route.sessionKey,
        }) ?? undefined
      : undefined;

    const envelopeOptions = channel.reply?.resolveEnvelopeFormatOptions
      ? channel.reply.resolveEnvelopeFormatOptions(safeCfg)
      : undefined;

    const body = channel.reply?.formatAgentEnvelope
      ? channel.reply.formatAgentEnvelope({
          channel: "WeCom",
          from: fromLabel,
          previousTimestamp,
          envelope: envelopeOptions,
          body: rawBody,
        })
      : rawBody;

    const ctxPayload = (channel.reply?.finalizeInboundContext
      ? channel.reply.finalizeInboundContext({
          Body: body,
          RawBody: rawBody,
          CommandBody: rawBody,
          From: chatType === "group" ? `wecom:group:${chatId}` : `wecom:${senderId}`,
          To: `wecom:${chatId}`,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: chatType,
          ConversationLabel: fromLabel,
          SenderName: senderId,
          SenderId: senderId,
          Provider: "wecom",
          Surface: "wecom",
          MessageSid: msg.msgid,
          OriginatingChannel: "wecom",
          OriginatingTo: `wecom:${chatId}`,
        })
      : {
          Body: body,
          RawBody: rawBody,
          CommandBody: rawBody,
          From: chatType === "group" ? `wecom:group:${chatId}` : `wecom:${senderId}`,
          To: `wecom:${chatId}`,
          SessionKey: route.sessionKey,
          AccountId: route.accountId,
          ChatType: chatType,
          ConversationLabel: fromLabel,
          SenderName: senderId,
          SenderId: senderId,
          Provider: "wecom",
          Surface: "wecom",
          MessageSid: msg.msgid,
          OriginatingChannel: "wecom",
          OriginatingTo: `wecom:${chatId}`,
        }) as {
      SessionKey?: string;
      [key: string]: unknown;
    };

    if (channel.session?.recordInboundSession && storePath) {
      await channel.session.recordInboundSession({
        storePath,
        sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
        ctx: ctxPayload,
        onRecordError: (err: unknown) => {
          logger.error(`wecom: failed updating session meta: ${String(err)}`);
        },
      });
    }

    const tableMode = channel.text?.resolveMarkdownTableMode
      ? channel.text.resolveMarkdownTableMode({ cfg: safeCfg, channel: "wecom", accountId: account.accountId })
      : undefined;

    await channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg: safeCfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string }) => {
          const rawText = payload.text ?? "";
          if (!rawText.trim()) return;
          const converted = channel.text?.convertMarkdownTables && tableMode
            ? channel.text.convertMarkdownTables(rawText, tableMode)
            : rawText;
          hooks.onChunk(converted);
        },
        onError: (err: unknown, info: { kind: string }) => {
          hooks.onError?.(err);
          logger.error(`${info.kind} reply failed: ${String(err)}`);
        },
      },
    });
  } finally {
    // 媒体文件保留在 /tmp/wecom/yyyymm/ 供后续使用，不再自动清理
  }
}

// ============================================================================
// 媒体文件处理
// ============================================================================

/**
 * HTTP 请求超时时间（毫秒）
 */
const HTTP_REQUEST_TIMEOUT = 30000;

/**
 * 媒体下载超时时间（毫秒）
 */
const MEDIA_DOWNLOAD_TIMEOUT = 60000;

/**
 * 已下载的媒体文件信息
 */
export interface DownloadedMediaFile {
  /** 本地文件路径 */
  path: string;
  /** MIME 内容类型 */
  contentType: string;
  /** 文件大小（字节） */
  size: number;
  /** 原始文件名（如果有） */
  fileName?: string;
  /** 清理函数（可选，不再自动清理） */
  cleanup?: () => Promise<void>;
}

/**
 * 从 URL 下载并解密企业微信媒体文件
 *
 * @param params 下载参数
 * @returns 已下载的媒体文件信息
 *
 * @example
 * ```typescript
 * const mediaFile = await downloadAndDecryptMedia({
 *   mediaUrl: "https://qyapi.weixin.qq.com/cgi-bin/media/download?xxx",
 *   encodingAESKey: "your_encoding_aes_key",
 *   logger,
 * });
 * console.log(`Decrypted file saved to: ${mediaFile.path}`);
 * // 使用完后清理
 * await mediaFile.cleanup();
 * ```
 */
export async function downloadAndDecryptMedia(params: {
  /** 媒体文件 URL */
  mediaUrl: string;
  /** Base64 编码的 AES 密钥 */
  encodingAESKey: string;
  /** 原始文件名（可选，用于确定文件扩展名） */
  fileName?: string;
  /** 日志记录器（可选） */
  log?: Logger;
}): Promise<DownloadedMediaFile> {
  const { mediaUrl, encodingAESKey, fileName, log } = params;

  if (!mediaUrl) {
    throw new Error("mediaUrl is required");
  }

  if (!encodingAESKey) {
    throw new Error("encodingAESKey is required");
  }

  // 步骤 1: 下载加密的媒体文件
  log?.debug?.(`[wecom] 下载加密媒体文件: ${mediaUrl.slice(0, 100)}...`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), MEDIA_DOWNLOAD_TIMEOUT);

  let encryptedBuffer: Buffer;
  let contentType = "application/octet-stream";
  let contentDisposition: string | null = null;

  try {
    const response = await fetch(mediaUrl, { signal: controller.signal });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    contentType = response.headers.get("content-type") || "application/octet-stream";
    contentDisposition = response.headers.get("content-disposition");
    const arrayBuffer = await response.arrayBuffer();
    encryptedBuffer = Buffer.from(arrayBuffer);

    log?.debug?.(`[wecom] 下载完成: ${encryptedBuffer.length} 字节`);
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`媒体下载超时（${MEDIA_DOWNLOAD_TIMEOUT}ms）`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }

  // 步骤 2: 解密媒体文件
  log?.debug?.(`[wecom] 解密媒体文件...`);

  let decryptedBuffer: Buffer;
  try {
    decryptedBuffer = decryptWecomMedia({
      encryptedBuffer,
      encodingAESKey,
    });
    log?.debug?.(`[wecom] 解密完成: ${decryptedBuffer.length} 字节`);
  } catch (err) {
    throw new Error(`解密失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 步骤 3: 保存到按月归档目录

  // 从 Content-Disposition 响应头中提取原始文件名
  const sanitizeFileName = (input?: string): string | undefined => {
    if (!input) return undefined;
    const base = path.basename(input);
    const cleaned = base
      .replace(/[\\\/]+/g, "_")
      .replace(/[\x00-\x1f\x7f]/g, "")
      .trim();
    if (!cleaned || cleaned === "." || cleaned === "..") return undefined;
    return cleaned.length > 200 ? cleaned.slice(0, 200) : cleaned;
  };

  let originalFileName = sanitizeFileName(fileName);
  if (contentDisposition && !originalFileName) {
    // 解析 Content-Disposition: attachment; filename="文件名.jpg"
    const filenameMatch = contentDisposition.match(/filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/);
    if (filenameMatch && filenameMatch[1]) {
      let headerFileName = filenameMatch[1].replace(/['"]/g, ""); // 移除引号
      // 尝试解码 URL 编码的文件名
      try {
        headerFileName = decodeURIComponent(headerFileName);
      } catch {
        // 如果解码失败，使用原始值
      }
      originalFileName = sanitizeFileName(headerFileName);
    }
  }

  // 确定文件扩展名
  let extension = '';
  if (originalFileName) {
    const lastDotIndex = originalFileName.lastIndexOf('.');
    if (lastDotIndex > 0) {
      extension = originalFileName.slice(lastDotIndex); // 保留 .xxx
    }
  }
  // 如果没有扩展名，从 contentType 推断
  if (!extension) {
    extension = resolveExtension(contentType, '');
  }

  // 生成月份目录：/tmp/wecom/yyyymm/
  const now = new Date();
  const yearMonth = now.toISOString().slice(0, 7).replace('-', ''); // yyyymm 格式
  const wecomDir = path.join('/tmp', 'wecom', yearMonth);

  // 确保目录存在
  await fsPromises.mkdir(wecomDir, { recursive: true });

  // 生成文件名：原始文件名-时间戳.扩展名（防止重名）
  const baseFileName = originalFileName || `wecom-media`;
  // 移除原始文件名的扩展名（如果有的话），因为我们已经单独处理了
  const baseNameWithoutExt = baseFileName.replace(/\.[-.\w]+$/, '');
  const timestamp = Date.now();
  const safeFileName = `${baseNameWithoutExt}-${timestamp}${extension}`;
  const resolvedDir = path.resolve(wecomDir);
  const resolvedPath = path.resolve(wecomDir, safeFileName);
  if (!resolvedPath.startsWith(`${resolvedDir}${path.sep}`) && resolvedPath !== resolvedDir) {
    throw new Error("Invalid media file path");
  }

  await fsPromises.writeFile(resolvedPath, decryptedBuffer);

  log?.debug?.(`[wecom] 文件已保存: ${resolvedPath}`);

  // 返回文件信息（不再提供清理函数，文件保留供后续使用）
  return {
    path: resolvedPath,
    contentType,
    size: decryptedBuffer.length,
    fileName,
  };
}

/**
 * 处理消息中的媒体文件（图片/文件/语音）
 *
 * 检测消息类型并下载解密媒体文件（如果有 URL）
 *
 * @param params 处理参数
 * @returns 包含本地文件路径的文本，或原始文本
 */
export async function processMediaInMessage(params: {
  msg: WecomInboundMessage;
  encodingAESKey?: string;
  log?: Logger;
}): Promise<{ text: string }> {
  const { msg, encodingAESKey, log } = params;

  // 如果没有配置 AES Key，无法解密，返回原始文本
  if (!encodingAESKey) {
    log?.debug?.(`[wecom] 未配置 encodingAESKey，跳过媒体解密`);
    return { text: extractWecomContent(msg) };
  }

  const msgtype = String(msg.msgtype ?? "").toLowerCase();

  // 处理混合消息（mixed）- 优先处理，因为 mixed 可能包含图片
  if (msgtype === "mixed") {
    const items = (msg as { mixed?: { msg_item?: unknown } }).mixed?.msg_item;
    if (Array.isArray(items)) {
      const processedParts: string[] = [];

      for (const item of items) {
        if (!item || typeof item !== "object") continue;
        const typed = item as { msgtype?: string; text?: { content?: string }; image?: { url?: string } };
        const t = String(typed.msgtype ?? "").toLowerCase();

        if (t === "text") {
          const content = String(typed.text?.content ?? "");
          processedParts.push(content);
        } else if (t === "image") {
          const url = String(typed.image?.url ?? "").trim();
          if (url) {
            try {
              const mediaFile = await downloadAndDecryptMedia({
                mediaUrl: url,
                encodingAESKey,
                fileName: "image.jpg",
                log,
              });
              processedParts.push(`[image] ${mediaFile.path}`);
            } catch (err) {
              log?.error?.(`[wecom] mixed消息中图片下载解密失败: ${err}`);
              processedParts.push(`[image] ${url}`);
            }
          }
        } else if (t === "file") {
          const url = String((typed as { file?: { url?: string; filename?: string } }).file?.url ?? "").trim();
          const fileName = String((typed as { file?: { url?: string; filename?: string } }).file?.filename ?? "file.bin").trim();
          if (url) {
            try {
              const mediaFile = await downloadAndDecryptMedia({
                mediaUrl: url,
                encodingAESKey,
                fileName,
                log,
              });
              processedParts.push(`[file] ${mediaFile.path}`);
            } catch (err) {
              log?.error?.(`[wecom] mixed消息中文件下载解密失败: ${err}`);
              processedParts.push(`[file] ${url}`);
            }
          }
        } else {
          processedParts.push(t ? `[${t}]` : "");
        }
      }

      return {
        text: processedParts.filter(p => Boolean(p && p.trim())).join("\n"),
      };
    }
    return { text: extractWecomContent(msg) };
  }

  // 处理图片消息
  if (msgtype === "image") {
    const url = String((msg as { image?: { url?: string } }).image?.url ?? "").trim();
    if (url) {
      try {
        const mediaFile = await downloadAndDecryptMedia({
          mediaUrl: url,
          encodingAESKey,
          fileName: "image.jpg", // 默认文件名
          log,
        });
        return {
          text: `[image] ${mediaFile.path}`,
        };
      } catch (err) {
        log?.error?.(`[wecom] 图片下载解密失败: ${err}`);
        return { text: extractWecomContent(msg) };
      }
    }
  }

  // 处理文件消息
  if (msgtype === "file") {
    const url = String((msg as { file?: { url?: string } }).file?.url ?? "").trim();
    const fileName = (msg as { file?: { filename?: string } }).file?.filename;
    if (url) {
      try {
        const mediaFile = await downloadAndDecryptMedia({
          mediaUrl: url,
          encodingAESKey,
          fileName,
          log,
        });
        return {
          text: `[file] ${mediaFile.path}`,
        };
      } catch (err) {
        log?.error?.(`[wecom] 文件下载解密失败: ${err}`);
        return { text: extractWecomContent(msg) };
      }
    }
  }

  // 处理语音消息
  if (msgtype === "voice") {
    const url = String((msg as { voice?: { url?: string } }).voice?.url ?? "").trim();
    if (url) {
      try {
        const mediaFile = await downloadAndDecryptMedia({
          mediaUrl: url,
          encodingAESKey,
          fileName: "voice.amr", // 默认文件名
          log,
        });
        return {
          text: `[voice] ${mediaFile.path}`,
        };
      } catch (err) {
        log?.error?.(`[wecom] 语音下载解密失败: ${err}`);
        return { text: extractWecomContent(msg) };
      }
    }
  }
  // 其他消息类型直接返回原始文本
  return { text: extractWecomContent(msg) };
}
