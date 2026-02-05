---
name: wecom-app-ops
description: 企业微信自建应用（wecom-app）运维与使用技能包。用于：在 wecom-app 渠道中定位并发送图片/文件/录音；从入站 media 目录读取 saved: 路径；获取/规范化 target（user:xxx / chatid / replyTo）；排查发送失败（requires a target / Unknown target / ok=false）；以及配置入站媒体保留策略（inboundMedia.keepDays/dir）。
---

# wecom-app 运维/使用规范（本地技能）

本技能针对你这套 OpenClaw + 企业微信自建应用（wecom-app）环境，提供可复用的“怎么做”步骤。

## 0) 快速判断：你要做哪一类事？

- **A. 回发媒体（图片/录音/文件）**：需要拿到本地路径 + 正确的 `target`（通常 `user:<name>`）
- **B. 从消息里拿 saved: 路径做 OCR/二次处理**：使用 `saved:/.../inbound/YYYY-MM-DD/...` 的稳定路径
- **C. 修复“找不到图片/自动删除”**：检查 wecom-app 的 `inboundMedia.keepDays/dir` 与插件版本

---

## 1) target 与 replyTo（最容易踩坑）

### 1.1 target 是什么
使用 `message.send` 向 wecom-app 主动发消息时，必须提供可解析 target（否则会报 `Action send requires a target.`）。

常见可用形式（以本环境为准）：
- `target: "user:<name>"`（例如 `user:CaiHongYu`）
- 群聊通常是 `chatid:<id>`（若插件/环境提供）

### 1.2 replyTo 怎么用
- 如果你要“回复当前对话”，优先使用消息的 `message_id` 作为 `replyTo`。
- `replyTo` 不是 target；target 仍然要填。

### 1.3 Unknown target 怎么办（排查步骤）
- 显示名（比如 `CaiHongYu`）不一定能被解析。
- 优先尝试：`target: "user:CaiHongYu"`

若仍报 `Unknown target`：
1) 先确认是 **私聊** 还是 **群聊**：
   - 私聊：需要 `user:<userId>`
   - 群聊：需要 `chatid:<chatId>`（群名几乎不可用）
2) 让对方（或你自己）在企业微信里再发一条消息（任意内容），以便系统记录真实标识。
3) 从以下任意来源抓取真实的 `userId/chatId`：
   - OpenClaw / wecom-app 插件日志（`~/.openclaw/logs/`）
   - 或把“收到消息时的原始字段/报错日志”贴出来，我来反推。
4) 拿到真实值后再发：
   - `target: "user:<userId>"` 或 `target: "chatid:<chatId>"`

---

## 2) 媒体文件在哪里？（图片/录音/文件）

### 2.1 入站媒体（推荐稳定路径）
wecom-app 现在会把入站媒体归档到：
- `inboundMedia.dir/YYYY-MM-DD/`
- 默认（跨平台）：`~/.openclaw/media/wecom-app/inbound/YYYY-MM-DD/`

消息正文会出现：
- `[image] saved:/.../inbound/YYYY-MM-DD/img_...jpg`
- `[voice] saved:/.../inbound/YYYY-MM-DD/voice_...amr`

这条 saved 路径用于：OCR、回发、复用。

### 2.2 临时目录（不建议依赖）
- `/tmp/wecom-app-media/` 只作为下载中转，不保证长期存在。

---

## 3) 回发图片/文件/录音（标准做法）

### 3.1 回发图片（注意：必须是真图片格式）
使用 `message` 工具：
- `channel: "wecom-app"`
- `target: "user:<name>"`
- `path: "<本地文件路径>"`
- `replyTo: "<message_id>"`（可选但推荐）

**格式要求（踩坑高发）：**
- 优先使用真正的图片格式：`.png` / `.jpg` / `.jpeg`
- `.svg` 在企业微信里通常不会按“图片消息”展示。
  - 新版本插件会把 `.svg` **按文件发送**，避免误走图片通道。
  - 若你需要“图片预览”：请先把 svg 转 png 再发（可选工具：`rsvg-convert` / ImageMagick `convert` / 或用脚本生成 PNG 兜底）。

### 3.2 回发录音（语音格式坑）
- **推荐格式**：`.amr`（你收到的入站语音也通常是 amr）
- `.wav` 在企业微信自建应用里经常无法作为“语音消息”发送（会 ok=false 或被拒绝）。
  - 新版本插件会把 `.wav` **降级为文件发送**（至少能发出去）。
  - 如需“语音气泡”展示：请把 wav 转 amr 后再发。
  - 转码示例（ffmpeg）：

```bash
ffmpeg -i in.wav -ar 8000 -ac 1 -c:a amr_nb out.amr
```

- 其他流程同图片。

### 3.3 回发 README/文本为“文件形式”
- 先写到临时文件（如 `/tmp/xxx.md`）
- 再用 `message.send` 的 `path` 作为附件发送。

---

## 4) 发送失败的排障清单

### 4.1 `Action send requires a target`
- 说明 target 缺失：补 `target:"user:..."`。

### 4.2 `Unknown target` / 发送 ok=false
- 优先确认 target 是否能解析（`user:<name>` vs 内部 id）。
- 尝试换成另一种 target（若有）或让用户提供 chatid。
- 检查附件路径是否存在（文件是否被清理）。

### 4.3 图片发不出去但文件存在
- 核对文件大小是否超出渠道限制。
- 若是 inbound 归档文件：确保 OpenClaw 进程对该文件可读。

---

## 5) 入站媒体保留策略（产品级默认）

- `inboundMedia.keepDays`：默认 7 天（延迟清理，不会“回复后立刻删”）
- `inboundMedia.dir`：可自定义归档目录
- `inboundMedia.maxBytes`：单个媒体大小限制（默认 10MB）

要修改：编辑 `openclaw.json` 的 `channels.wecom-app.inboundMedia`。

可复制模板：
```json
{
  "channels": {
    "wecom-app": {
      "inboundMedia": {
        "enabled": true,
        "keepDays": 7,
        "maxBytes": 10485760
      }
    }
  }
}
```

---

## 6) MCP OCR（识别图片文字）

当用户说“记得调用 mcp 识别图片”，用 `mcporter` 调用：
- `zai-mcp-server.extract_text_from_screenshot(image_source: <saved-path>, prompt: <说明>)`

前提：必须拿到**真实存在的文件路径**（建议用 inbound saved 路径）。

---

## 参考
- 详细示例与常用模板见：`references/wecom-app-examples.md`
