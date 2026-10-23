# QQ 机器人 · EdgeOne Pages 部署版

QQ 官方机器人（Webhook 模式）+ 大模型对话 + 群管理（广告过滤/禁言/拉黑）+ **管理后台**，零第三方依赖，跑在腾讯云边缘节点。

## ✨ 功能

| 功能 | 说明 |
|---|---|
| 🤖 AI 对话 | OpenAI 兼容接口（DeepSeek/智谱/Kimi/OpenAI…），按群维护上下文 |
| 🛡 广告过滤 | 内置规则（联系方式/链接/诱导/刷屏）+ 自定义关键词/正则（环境变量 + 后台动态维护） |
| ⚖️ 违规处罚 | 真 @ 警告（先警告后撤回，保证回复可达）→ 撤回 → 撤回+阶梯禁言（按 `AD_ACTION` 分级，最长可配 30 天） |
| 👋 进群欢迎 | 新成员进群、机器人进群自动欢迎 |
| 🚪 退群拉黑 | `/退群 @某人` 退群登记：群内 @ 提示 + 加入黑名单（黑名单成员消息一律静默忽略） |
| 🛠 管理指令 | 禁言/解禁/踢人/拉黑/退群登记/违规分/开关功能（openid 白名单） |
| 💰 成本护栏 | 每分钟频控 + 每日调用预算上限 |
| 🖥 管理后台 | 登录鉴权、数据概览、核心数据增删改查、搜索筛选分页、状态与权限管理、操作日志 |

## 📁 目录结构

```
qq-bot/
├── package.json                 # ESM，零依赖
├── dev-server.mjs               # 本地开发服务器 :8788
├── .env.example                 # 环境变量模板
├── admin/
│   └── index.html               # 管理后台前端（原生 HTML/CSS/JS，零依赖）
├── functions/                   # EdgeOne Pages 函数（文件即路由）
│   └── api/
│       ├── qq/
│       │   ├── webhook.js       # POST /api/qq/webhook
│       │   └── health.js        # GET  /api/qq/health
│       └── admin/               # 后台接口
│           ├── login.js         # POST   /api/admin/login
│           ├── logout.js        # POST   /api/admin/logout
│           ├── me.js            # GET    /api/admin/me
│       ├── overview.js      # GET    /api/admin/overview
│           ├── groups.js        # GET/POST/PUT/DELETE
│           ├── members.js
│           ├── violations.js
│           ├── rules.js
│           ├── admins.js
│           └── logs.js          # GET/DELETE（只读，禁止外部写入）
└── src/
    ├── core.js                  # 入口：健康检查/验签/事件分发
    ├── verify.js                # Ed25519 验签（Web Crypto）
    ├── config.js                # 环境变量集中读取
    ├── handlers.js              # 业务流水线
    ├── adfilter.js              # 广告检测
    ├── moderation.js            # 违规计数与处罚决策
    ├── qqapi.js                 # QQ v2 OpenAPI 封装
    ├── ai.js                    # 大模型对话 + 频控 + 预算
    ├── kv.js                    # 存储适配层（KV / 内存）
    ├── repo.js                  # 集合数据访问（CRUD/查询/分页）
    ├── records.js               # 群/成员/违规/统计落库
    ├── store.js                 # 内存存储驱动
    └── admin/
        ├── auth.js              # 口令哈希 + 会话签名
        ├── api.js               # 守卫 / 分页 / 审计
        └── crud.js              # 通用集合 CRUD
```

## 🚀 部署

### 方式 A：控制台直接上传（推荐首次使用）
1. 把 `functions/`、`src/`、`admin/`、`package.json` 压缩为 `qq-bot.zip`（保持它们在 zip 根目录）
2. **不要**打包 `.env`、`node_modules`
3. [EdgeOne Pages 控制台](https://console.cloud.tencent.com/edgeone/pages) → 创建项目 → 「直接上传」
4. 部署后得到域名，如 `https://xxx.edgeone.app`

### 方式 B：CLI 部署
```bash
npx edgeone pages link        # 关联项目（可选，用于同步 KV 与环境变量）
npx edgeone pages deploy ./qq-bot.zip -n <项目名>
```

### 方式 C：Git / CI/CD
关联 GitHub / Gitee，push 自动触发构建部署。

> **构建提示**：`functions/api/qq/webhook.js` 通过 `../../../src/core.js` 引用根目录 `src/`。EdgeOne 构建器通常会打包函数目录外的相对引用，首次部署请确认 `src/*.js` 被正确 bundle。

### ⚠️ 运行时注意事项（重要）
- 本项目部署在 EdgeOne **边缘函数（`functions/` 目录，V8 运行时）**。该运行时提供的是标准 **Web Crypto API**，**不保证存在 `node:crypto`**。
- 因此验签统一使用 `globalThis.crypto.subtle` 实现（见 `src/verify.js`）。
- 若你的边缘环境实测 `crypto.subtle.importKey({ name: 'Ed25519' })` 报不支持，请把函数迁移到 **Node.js `cloud-functions` 运行时**（`node:crypto` 必可用），并相应调整 `ctx.waitUntil` 的使用方式。

## 🔐 环境变量

| 变量 | 必填 | 说明 |
|---|---|---|
| `APP_ID` | ✅ | QQ 开放平台机器人 ID |
| `APP_SECRET` | ✅ | 机器人密钥 |
| `CALLBACK_PUBLIC_KEY` | | 可选。Ed25519 验签公钥（base64）；**缺省时自动由 `APP_SECRET` 按官方算法派生**，一般无需配置 |
| `SIGN_TOLERANCE` | | 时间戳容差（秒），默认 300 |
| `AI_API_KEY` | AI对话 | 大模型 API Key |
| `AI_BASE_URL` | | 默认 `https://api.deepseek.com/v1` |
| `AI_MODEL` | | 默认 `deepseek-chat` |
| `AI_ENABLED` | | 默认 1 |
| `AI_TIMEOUT_MS` | | 默认 30000 |
| `AI_MAX_CONTEXT` | | 默认 10 |
| `AI_MAX_TOKENS` | | 默认 800 |
| `AI_RATE_LIMIT_ENABLED` | | AI 频控开关，默认 1 |
| `AI_RATE_LIMIT_PER_MIN` | | 每会话每分钟上限，默认 10 |
| `AI_DAILY_LIMIT` | | 每日 AI 调用总上限，0=不限，默认 0 |
| `AD_FILTER_ENABLED` | | 广告过滤总开关，默认 1 |
| `AD_ACTION` | | `warn`|`delete`|`delete_mute`，默认 `delete_mute` |
| `AD_MUTE_THRESHOLD` | | 第 N 次违规开始禁言，默认 3 |
| `AD_MUTE_SECONDS` | | 首次禁言秒数，默认 600 |
| `AD_MUTE_MAX_SECONDS` | | 阶梯封顶，默认 86400 |
| `ADMIN_OPENIDS` | 管理指令 | 管理员 openid，逗号分隔 |
| `ADMIN_USERNAME` | 后台 | 默认 `admin` |
| `ADMIN_PASSWORD` | 后台✅ | **必填**；留空则后台登录接口禁用 |
| `ADMIN_SESSION_SECRET` | | 会话签名密钥，缺省回落到 `APP_SECRET` |
| `ADMIN_SESSION_TTL` | | 会话有效期（秒），默认 43200 |
| `ADMIN_COOKIE_SECURE` | | Cookie 是否仅 HTTPS，本地 http 调试设 `0` |
| `MOCK` | | 打开后 QQ API 只打印不真正请求 |

> 配置后需**重新部署**一次生效。

## 📡 QQ 开放平台配置
1. [q.qq.com](https://q.qq.com) 创建机器人（群聊场景）
2. 「开发设置 → 回调配置」：URL 填 `https://你的域名/api/qq/webhook`
3. 验签密钥**由 `APP_SECRET` 自动派生**（官方算法，`tools/derive-callback-key.mjs` 可查看公钥），无需额外配置
4. 点「推送验证」→ 平台发送 op=13（`plain_token`+`event_ts`）→ 服务端用派生私钥签名返回 `{"plain_token","signature"}` → 验证通过
5. 订阅事件（均属 `GROUP_AND_C2C_EVENT (1<<25)` intent）：
   - **必勾**：`GROUP_AT_MESSAGE_CREATE`（群@消息）、`C2C_MESSAGE_CREATE`（私聊）、`GROUP_ADD_ROBOT`（进群欢迎）
   - **建议**：`GROUP_DEL_ROBOT`（移出群→标记停用）、`FRIEND_ADD`（加好友引导）、`FRIEND_DEL`
   - 注意：**QQ 群体系没有 `GROUP_MEMBER_ADD`/`GROUP_MEMBER_REMOVE` 事件**（那是频道体系的 `GUILD_MEMBER_*`），群成员进出无法感知
6. 把机器人拉进群，给它**群管理员**身份（禁言/撤回需要）

## 🖥 管理后台

访问 `https://你的域名/`（自动跳转登录页），两个独立页面：

| 页面 | 路径 | 说明 |
|---|---|---|
| 登录页 | `/admin/login.html` | 只负责身份验证；已登录会自动跳进管理界面 |
| 管理界面 | `/admin/index.html` | 需登录才能进入；未登录访问会被强制跳回登录页 |

**首次登录**：用环境变量里配置的 `ADMIN_USERNAME` / `ADMIN_PASSWORD`（该账号固定为 `owner` 角色）。
登录成功后服务端下发 HMAC 签名的会话 Cookie（HttpOnly + SameSite=Lax）。
登录态失效（12 小时过期 / 退出）时，管理界面内任何接口返回 401 都会自动跳回登录页并提示原因（`?reason=logout` 已退出 / `?reason=expired` 已过期 / `?reason=auth` 未登录）。

**功能模块**
- **数据概览**：今日消息 / 今日 AI 调用 / 今日违规 / 群·成员数 / 违规记录数 / 规则数 / 日志数；违规规则 Top6 分布图；最近 5 条违规
- **群管理**：增删改查，按状态/名称/openid 搜索筛选，分页；可切换状态、AI 对话、广告过滤开关
- **成员管理**：按群/状态筛选，违规次数，禁言到期时间
- **违规记录**：查看/新增/更正/删除，含命中规则、命中内容、处置动作
- **广告规则**：关键词 / 正则动态维护（**立即对机器人生效**），可启停
- **管理员与权限**：后台账号与 QQ 侧管理员 openid 管理，角色 `owner`/`admin`/`viewer`，状态 `enabled`/`disabled`
- **操作日志**：所有后台写操作自动留痕（操作人、角色、动作、目标、详情）

**权限矩阵**

| 角色 | 读 | 写 |
|---|---|---|
| `owner` | 全部 | 群/成员/违规/规则/管理员 |
| `admin` | 全部 | 群/成员/违规/规则 |
| `viewer` | 全部 | 无 |

**接口约定**
- 列表：`GET /api/admin/{集合}?search=&<筛选字段>=&page=&pageSize=&sortKey=&sortDir=`
- 详情：`GET /api/admin/{集合}?id=`
- 新建：`POST`（JSON body，主键由服务端生成；群/成员支持客户端指定业务主键）
- 更新：`PUT ?id=`（JSON body，主键不可改）
- 删除：`DELETE ?id=`

> `logs` 为只读集合，拒绝 `POST`/`PUT`，防止外部伪造日志。

## 💾 持久化（KV）
状态默认存**内存**（单实例有效，冷启动/多实例会丢）。生产建议绑定 KV：
1. EdgeOne 控制台 → Database → KV Storage → 申请并创建 Namespace
2. 项目设置里 **Bind Namespace**，变量名填 **`BOT_KV`**
3. 代码自动识别并使用（后台概览页会显示「存储：KV（持久）」）

## 💬 群内指令
```
帮助            查看功能
ping            测试在线
时间            北京时间
复读 xxx        复读
/AI开 /AI关     开关 AI 对话（管理员）
/广告开 /广告关  开关广告过滤（管理员）
/禁言 @某人 10分钟
/解禁 @某人
/撤回           回复要撤回的消息后发送（管理员）
/踢 @某人       （需内邀权限）
/拉黑 @某人     （需内邀权限）
/退群 @某人     退群登记：@ 提示 + 加入黑名单（管理员）
/违规分 @某人    查询违规次数
/清违规 @某人    清零违规次数
/管理            管理指令列表
```

## 🧪 本地开发
```bash
cp .env.example .env      # 填好 ADMIN_PASSWORD 等
npm run dev               # :8788，含后台页面
npm test                  # 70 项自测
node probe/e2e.mjs        # 机器人主流程端到端
node probe/admin-e2e.mjs  # 管理后台端到端（需先起 dev server）
```

## ⚠️ 能力边界（官方 API 现状）
- **禁言/撤回**：已全量开放，机器人需群管理员身份
- **踢人/拉黑**：内邀白名单接口（错误码 11253），代码已实现，无权限时自动降级为本地黑名单（黑名单成员消息一律静默忽略）
- **成员退群事件**：群聊体系官方不推送普通成员退群（仅推送机器人自身被移出群 GROUP_DEL_ROBOT），故「退群提示 + 自动拉黑」由管理员发 `/退群 @某人` 手动登记触发
- **拦截入群**：官方无入群审批/拦截 API，无法阻止黑名单用户重新入群；替代措施是黑名单成员发言一律被忽略，建议配合群管理手动移出
- **被动回复**：msg_id 5 分钟内有效；主动消息有额度限制；违规警告为「先警告后撤回」，避免回复引用已撤回消息失败
- **KV 一致性**：最终一致，高频计数可能存在极小误差（群管场景可接受）

---

## 📌 变更记录（本次排查与增强）

### 修复
1. **验签不可用（部署阻断）**：`src/verify.js` 原用 `node:crypto`，边缘 V8 运行时不保证支持 → 改为 Web Crypto（`crypto.subtle`），并在 `src/core.js` 补两处 `await`。
2. **管理员指令 `@某人` 全部失效**：正文先被 strip 掉 `<@openid>`，再在剥离后的文本里找目标必然失败 → 改为先从原始 `d.content` 提取 mentions，再清理正文。
3. **`AD_ACTION` 配置从未生效**：处罚逻辑写死 → 现在按 `warn / delete / delete_mute` 分级执行。
4. **正文清理误伤**：旧的 `/@[^@\s]+\s*/g` 会破坏邮箱等含 `@` 的正常文本 → 只剥离 QQ 的 `<@openid>` 形式。
5. **缺失文件导致脚本不可用**：`package.json` 引用了不存在的 `dev-server.mjs` 和 `test/selftest.mjs` → 已补齐（含 55 项自测）。
6. **配置默认值与 README 不符**：README 说 DeepSeek，代码默认 OpenAI → 统一为 DeepSeek。
7. **会话/上下文不持久**：`store.js` 仅内存且 KV 注释未落地 → 新增 `kv.js`/`repo.js`/`records.js`，支持绑定 `BOT_KV` 持久化。
8. 附带补齐：`msg_seq` 可递增、AI 回复按码点截断防切 emoji、清理死代码 `pushMessage`。

### 新增
- 管理后台前端 `admin/index.html`（原生实现，零依赖）
- 后台接口 `functions/api/admin/*`（登录/登出/当前用户/概览/群/成员/违规/规则/管理员/日志）
- 角色权限矩阵与操作日志审计
- AI 每分钟频控 + 每日预算上限（成本护栏）
- 探针脚本 `probe/e2e.mjs`、`probe/admin-e2e.mjs`
