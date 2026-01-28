# moltbot-china

中国 IM 平台 Moltbot 扩展插件集合。

⭐ 如果这个项目对你有帮助，请给个Star支持一下~


> 🚧 **即将支持**：直接通过 `npm install @moltbot-china/dingtalk` 安装，无需手动复制文件和修改配置。

## 演示

![钉钉机器人演示](doc/images/dingtalk-demo_2.gif)

## 支持平台

| 平台 | 状态 | 插件 |
|------|:----:|------|
| 钉钉 | ✅ 可用 | `@moltbot-china/dingtalk` |
| 飞书 | 🚧 开发中 |  |
| 企业微信 | 🚧 开发中 |  |
| QQ机器人 | 🚧 开发中 |  |

## 安装

```bash
npm install
# 或
pnpm install
```

## 钉钉插件配置

> 📖 **[钉钉企业注册指南](doc/guides/dingtalk/configuration.md)** — 无需任何材料，最快 5 分钟完成配置


在 Moltbot 配置文件 `/root/.clawdbot/clawdbot.json` 中添加钉钉渠道配置：

```json
{
  "plugins": {
    "load": {
      "paths": ["/path/to/moltbot-china/extensions/dingtalk"]
    },
    "entries": {
      "dingtalk": { "enabled": true }
    }
  },
  "channels": {
    "dingtalk": {
      "enabled": true,
      "clientId": "YOUR_APP_KEY",
      "clientSecret": "YOUR_APP_SECRET",
      "dmPolicy": "pairing",
      "groupPolicy": "allowlist",
      "requireMention": true,
      "allowFrom": [],
      "groupAllowFrom": []
    }
  }
}
```

配置说明：
- `clientId` / `clientSecret`：**必填**，钉钉开放平台应用凭证（其他配置项可使用默认值）
- `dmPolicy`：私聊策略 - `open`（任何人）/ `pairing`（需先配对）/ `allowlist`（白名单）
- `groupPolicy`：群聊策略 - `open`（任何群）/ `allowlist`（白名单群）
- `requireMention`：群聊中是否需要 @机器人 才响应
- `allowFrom`：私聊白名单用户 ID 列表
- `groupAllowFrom`：群聊白名单群 ID 列表

## License

MIT
