# QQ 机器人 · EdgeOne Pages 部署版

QQ 官方机器人（Webhook 模式）+ 大模型对话 + 群管理（广告过滤/禁言/拉黑），零依赖，跑在腾讯云边缘节点。

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🤖 AI 对话 | OpenAI 兼容接口（DeepSeek/智谱/Kimi/OpenAI…），按群维护上下文 |
| 🛡 广告过滤 | 内置规则（联系方式/链接/诱导/刷屏）+ 自定义关键词/正则 |
| ⚖️ 违规处罚 | 警告 → 撤回 → 阶梯禁言（时长可配，最长 30 天） |
| 👋 进群欢迎 | 新成员进群、机器人进群自动欢迎 |
| 🚪 退群拉黑 | 退群自动加黑名单（需内邀权限，失败自动忽略） |
| 🛠 管理指令 | 禁言/解禁/踢人/拉黑/违规分/开关功能（openid 白名单） |

## 🚀 部署（zip 直传，3 分钟）

### 1. 打包
把本项目（保留 `functions/`、`src/`、`package.json` 在 zip 根目录）压缩为 `qq-bot.zip`。
**不要**把 `.env`、`node_modules`、`test` 打进去。

### 2. 上传
1. 打开 [EdgeOne Pages 控制台](https://console.cloud.tencent.com/edgeone/pages) → 创建项目
2. 选择「**直接上传**」→ 上传 `qq-bot.zip`
3. 部署完成后得到访问域名，如 `https://xxx.edgeone.app`

### 3. 配置环境变量
控制台「项目设置 → 环境变量」添加：

| 变量 | 必填 | 说明 |
|---|---|---|
| `APP_ID` | ✅ | QQ 开放平台机器人 ID |
| `APP_SECRET` | ✅ | 机器人密钥 |
| `CALLBACK_PUBLIC_KEY` | ✅ | 回调配置里的 Ed25519 公钥 |
| `AI_API_KEY` | AI对话 | 大模型 API Key |
| `AI_BASE_URL` | | 默认 DeepSeek：`https://api.deepseek.com/v1` |
| `AI_MODEL` | | 默认 `deepseek-chat` |
| `ADMIN_OPENIDS` | 管理指令 | 管理员 openid，逗号分隔 |
| `AD_FILTER_ENABLED` | | 广告过滤总开关，默认 1 |
| `AD_MUTE_THRESHOLD` | | 第 N 次违规开始禁言，默认 3 |
| `AD_MUTE_SECONDS` | | 首次禁言秒数，默认 600 |
| `LEAVE_BLACKLIST_ENABLED` | | 退群拉黑开关，默认 0 |

> 配置后**重新部署**一次生效。

### 4. QQ 开放平台配置
1. [q.qq.com](https://q.qq.com) 创建机器人（群聊场景）
2. 「开发设置 → 回调配置」：
   - URL：`https://你的域名/api/qq/webhook`
   - 把平台的 **Ed25519 公钥** 填到环境变量 `CALLBACK_PUBLIC_KEY`
3. 点「推送验证」→ 服务端自动回显 challenge → 验证通过
4. 订阅事件：`GROUP_AT_MESSAGE_CREATE`（群消息）、`C2C_MESSAGE_CREATE`（单聊）、`GROUP_MEMBER_ADD`、`GROUP_MEMBER_REMOVE`、`GROUP_ADD_ROBOT`
5. 把机器人拉进群，给它**群管理员**身份（禁言/撤回需要）

## 💬 群内指令

```
帮助            查看功能
ping            测试在线
时间            北京时间
/AI开 /AI关     开关 AI 对话（管理员）
/广告开 /广告关  开关广告过滤（管理员）
/禁言 @某人 10分钟
/解禁 @某人
/踢 @某人        （需内邀权限）
/拉黑 @某人      （需内邀权限）
/违规分 @某人    查询违规次数
/管理            管理指令列表
```

## ⚠️ 能力边界（官方 API 现状）

- **禁言/撤回**：已全量开放，机器人需群管理员身份
- **踢人/拉黑**：内邀白名单接口（错误码 11253），代码已实现，无权限时自动降级提示
- **被动回复**：msg_id 5 分钟内有效；主动消息有额度限制

## 🧪 本地开发

```bash
npm run dev     # 启动本地服务器 :8788
npm test        # 37 项自测
```
