/**
 * 环境变量集中读取（带默认值）
 */

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const bool = (v, d) => (v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase()));
const list = (v) => String(v || '').split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean);

export function loadConfig(env = {}) {
  return {
    // QQ 开放平台
    APP_ID: env.APP_ID,
    APP_SECRET: env.APP_SECRET,
    CALLBACK_PUBLIC_KEY: env.CALLBACK_PUBLIC_KEY,
    SIGN_TOLERANCE: num(env.SIGN_TOLERANCE, 300),
    MOCK: bool(env.MOCK, false),

    // 大模型（OpenAI 兼容接口：deepseek / moonshot / 智谱 / openai 均可）
    AI_BASE_URL: (env.AI_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    AI_API_KEY: env.AI_API_KEY || '',
    AI_MODEL: env.AI_MODEL || 'deepseek-chat',
    AI_SYSTEM_PROMPT: env.AI_SYSTEM_PROMPT ||
      '你是一个友好的QQ群机器人助手，回答简洁准确，避免敏感内容。',
    AI_TIMEOUT_MS: num(env.AI_TIMEOUT_MS, 30000),
    AI_MAX_CONTEXT: num(env.AI_MAX_CONTEXT, 10),   // 保留最近 N 条上下文
    AI_MAX_TOKENS: num(env.AI_MAX_TOKENS, 800),
    AI_ENABLED: bool(env.AI_ENABLED, true),

    // AI 调用限流（防刷屏导致费用失控）
    AI_RATE_LIMIT_ENABLED: bool(env.AI_RATE_LIMIT_ENABLED, true),
    AI_RATE_LIMIT_PER_MIN: num(env.AI_RATE_LIMIT_PER_MIN, 10), // 每会话每 60 秒上限
    AI_DAILY_LIMIT: num(env.AI_DAILY_LIMIT, 0),             // 每日 AI 调用总上限，0=不限

    // 广告过滤
    AD_FILTER_ENABLED: bool(env.AD_FILTER_ENABLED, true), // 全局总开关
    AD_ACTION: env.AD_ACTION || 'delete_mute',            // warn | delete | delete_mute
    AD_MUTE_SECONDS: num(env.AD_MUTE_SECONDS, 600),       // 命中后禁言时长
    AD_MUTE_THRESHOLD: num(env.AD_MUTE_THRESHOLD, 3),     // 第 N 次违规才禁言
    AD_MUTE_MAX_SECONDS: num(env.AD_MUTE_MAX_SECONDS, 86400),
    AD_KICK_THRESHOLD: num(env.AD_KICK_THRESHOLD, 4),     // 第 N 次违规踢出群聊并拉黑（0=关闭）
    AD_KEYWORDS: list(env.AD_KEYWORDS),                   // 额外关键词
    AD_REGEX: list(env.AD_REGEX),                          // 额外正则

    // 欢迎词 / 退群提示（后台「欢迎词设置」优先级更高，这里仅作环境变量兜底）
    WELCOME_ENABLED: bool(env.WELCOME_ENABLED, true),      // 迎宾/送别总开关
    WELCOME_MEMBER: env.WELCOME_MEMBER || '',              // 新成员进群欢迎词
    WELCOME_BOT: env.WELCOME_BOT || '',                    // 机器人进群欢迎词
    LEAVE_NOTICE: env.LEAVE_NOTICE || '',                  // 成员退群提示
    JOIN_NOTICE: env.JOIN_NOTICE || '',                    // 入群申请群内通知（{name}/{source}/{time}/{tips}）
    AUTO_BLACKLIST_ON_LEAVE: bool(env.AUTO_BLACKLIST_ON_LEAVE, true), // 退群自动拉黑

    // 管理：openid 白名单（逗号分隔），这些用户可发管理指令
    ADMIN_OPENIDS: list(env.ADMIN_OPENIDS),

    // 管理指令默认禁言上限（秒）
    ADMIN_MAX_MUTE_SECONDS: num(env.ADMIN_MAX_MUTE_SECONDS, 30 * 86400),

    // ---- 管理后台 ----
    ADMIN_USERNAME: env.ADMIN_USERNAME || 'admin',
    /** 未设置时后台登录接口将明确拒绝，避免出现无鉴权入口 */
    ADMIN_PASSWORD: env.ADMIN_PASSWORD || '',
    /** 会话签名密钥，缺省回落到 APP_SECRET */
    ADMIN_SESSION_SECRET: env.ADMIN_SESSION_SECRET || env.APP_SECRET || '',
    ADMIN_SESSION_TTL: num(env.ADMIN_SESSION_TTL, 12 * 3600),
    /** 会话 Cookie 是否仅 HTTPS；本地 http 调试可设 0 */
    ADMIN_COOKIE_SECURE: env.ADMIN_COOKIE_SECURE ?? '1',
  };
}

export default { loadConfig };
