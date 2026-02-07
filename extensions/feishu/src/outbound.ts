/**
 * 飞书出站适配器
 */

import { sendFileFeishu, sendImageFeishu, sendMarkdownCardFeishu, sendMessageFeishu } from "./send.js";
import { getFeishuRuntime } from "./runtime.js";
import type { FeishuConfig } from "./types.js";
import { FeishuConfigSchema } from "./config.js";
import { extractFilesFromText, extractImagesFromText, isHttpUrl, isImagePath, normalizeLocalPath } from "@openclaw-china/shared";
import * as fs from "node:fs";

export interface OutboundConfig {
  channels?: {
    "feishu-china"?: FeishuConfig;
  };
}

export interface SendResult {
  channel: string;
  messageId: string;
  chatId?: string;
  conversationId?: string;
}

function isFeishuImageKey(value: string): boolean {
  return /^img_v\d+_/i.test(value.trim());
}

function parseTarget(to: string): { targetId: string; receiveIdType: "chat_id" | "open_id" } {
  if (to.startsWith("chat:")) {
    return { targetId: to.slice(5), receiveIdType: "chat_id" };
  }
  if (to.startsWith("user:")) {
    return { targetId: to.slice(5), receiveIdType: "open_id" };
  }
  return { targetId: to, receiveIdType: "chat_id" };
}

export const feishuOutbound = {
  deliveryMode: "direct" as const,
  textChunkLimit: 4000,
  chunkerMode: "markdown" as const,

  chunker: (text: string, limit: number): string[] => {
    try {
      const runtime = getFeishuRuntime();
      if (runtime.channel?.text?.chunkMarkdownText) {
        return runtime.channel.text.chunkMarkdownText(text, limit);
      }
    } catch {
      // runtime 未初始化，返回原文
    }
    return [text];
  },

  sendText: async (params: { cfg: OutboundConfig; to: string; text: string }): Promise<SendResult> => {
    const { cfg, to, text } = params;

    const rawFeishuCfg = cfg.channels?.["feishu-china"];
    const parsedCfg = rawFeishuCfg ? FeishuConfigSchema.safeParse(rawFeishuCfg) : null;
    const feishuCfg = parsedCfg?.success ? parsedCfg.data : rawFeishuCfg;
    if (!feishuCfg) {
      throw new Error("Feishu channel not configured");
    }

    const { targetId, receiveIdType } = parseTarget(to);

    // 使用 shared 模块提取文本中的图片
    const { images } = extractImagesFromText(text, {
      removeFromText: false, // 保留原文，因为 Markdown 卡片会处理图片
      checkExists: false,
      parseMarkdownImages: true,
      parseHtmlImages: true,
      parseBarePaths: true,
    });

    // 使用 shared 模块提取文本中的文件（非图片）
    const { text: cleanedText, files } = extractFilesFromText(text, {
      removeFromText: true,
      checkExists: false,
      parseBarePaths: true,
      parseMarkdownLinks: true,
    });

    const localFiles = files
      .filter((f) => f.isLocal && f.localPath && !isImagePath(f.localPath))
      .map((f) => f.localPath as string)
      .filter((p) => {
        if (fs.existsSync(p)) return true;
        console.warn(`[feishu] local file not found: ${p}`);
        return false;
      });

    // 过滤出本地图片
    const localImages = images.filter((img) => img.isLocal && img.localPath);

    // 区分 Markdown/HTML 图片和裸本地路径
    // Markdown 卡片模式会处理 Markdown/HTML 图片，但不会处理裸本地路径
    // 使用 sourceKind 字段精确判断，避免字符串匹配的 URL 编码问题
    const bareLocalImages = localImages.filter((img) => img.sourceKind === "bare");

    // Minimal runtime trace for markdown vs text path
    const sendMode = feishuCfg.sendMarkdownAsCard ? "interactive markdown card" : "text message";
    // eslint-disable-next-line no-console
    console.log(
      `[feishu] outbound sendText via ${sendMode} (receive_id_type=${receiveIdType}, text_len=${text.length}, local_images=${localImages.length}, bare_local_images=${bareLocalImages.length}, local_files=${localFiles.length})`
    );

    // 发送主消息
    const result = feishuCfg.sendMarkdownAsCard
      ? await sendMarkdownCardFeishu({
          cfg: feishuCfg,
          to: targetId,
          text: cleanedText,
          receiveIdType,
        })
      : await sendMessageFeishu({
          cfg: feishuCfg,
          to: targetId,
          text: cleanedText,
          receiveIdType,
        });

    // 兜底补发逻辑：
    // - 非卡片模式：补发所有本地图片
    // - 卡片模式：只补发裸本地路径（Markdown/HTML 图片已被卡片处理）
    const imagesToFallback = feishuCfg.sendMarkdownAsCard ? bareLocalImages : localImages;

    if (imagesToFallback.length > 0) {
      console.log(`[feishu] fallback: sending ${imagesToFallback.length} local images`);
      for (const img of imagesToFallback) {
        if (!img.localPath) continue;
        try {
          await sendImageFeishu({
            cfg: feishuCfg,
            to: targetId,
            mediaUrl: img.localPath,
            receiveIdType,
          });
        } catch (err) {
          console.error(`[feishu] failed to send fallback image ${img.localPath}:`, err);
        }
      }
    }

    if (localFiles.length > 0) {
      const uniqueFiles = Array.from(new Set(localFiles));
      console.log(`[feishu] fallback: sending ${uniqueFiles.length} local files`);
      for (const filePath of uniqueFiles) {
        try {
          await sendFileFeishu({
            cfg: feishuCfg,
            to: targetId,
            mediaUrl: filePath,
            receiveIdType,
          });
        } catch (err) {
          console.error(`[feishu] failed to send fallback file ${filePath}:`, err);
        }
      }
    }

    return {
      channel: "feishu-china",
      messageId: result.messageId,
      chatId: result.chatId,
      conversationId: result.chatId,
    };
  },

  sendMedia: async (params: {
    cfg: OutboundConfig;
    to: string;
    text?: string;
    mediaUrl?: string;
  }): Promise<SendResult> => {
    const { cfg, to, text, mediaUrl } = params;

    const feishuCfg = cfg.channels?.["feishu-china"];
    if (!feishuCfg) {
      throw new Error("Feishu channel not configured");
    }

    const { targetId, receiveIdType } = parseTarget(to);

    if (text?.trim()) {
      await sendMessageFeishu({
        cfg: feishuCfg,
        to: targetId,
        text,
        receiveIdType,
      });
    }

    if (mediaUrl) {
      try {
        const sendAsImage = isFeishuImageKey(mediaUrl)
          ? true
          : isHttpUrl(mediaUrl)
            ? isImagePath(new URL(mediaUrl).pathname)
            : isImagePath(normalizeLocalPath(mediaUrl));
        const result = sendAsImage
          ? await sendImageFeishu({
              cfg: feishuCfg,
              to: targetId,
              mediaUrl,
              receiveIdType,
            })
          : await sendFileFeishu({
              cfg: feishuCfg,
              to: targetId,
              mediaUrl,
              receiveIdType,
            });
        return {
          channel: "feishu-china",
          messageId: result.messageId,
          chatId: result.chatId,
          conversationId: result.chatId,
        };
      } catch (err) {
        console.error(`[feishu] sendMedia failed:`, err);
        const fallbackText = `📎 ${mediaUrl}`;
        const result = await sendMessageFeishu({
          cfg: feishuCfg,
          to: targetId,
          text: fallbackText,
          receiveIdType,
        });
        return {
          channel: "feishu-china",
          messageId: result.messageId,
          chatId: result.chatId,
          conversationId: result.chatId,
        };
      }
    }

    return {
      channel: "feishu-china",
      messageId: text?.trim() ? `text_${Date.now()}` : "empty",
      chatId: targetId,
      conversationId: targetId,
    };
  },
};
