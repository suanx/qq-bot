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
    AI_BASE_URL: (env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    AI_API_KEY: env.AI_API_KEY || '',
    AI_MODEL: env.AI_MODEL || 'gpt-4o-mini',
    AI_SYSTEM_PROMPT: env.AI_SYSTEM_PROMPT ||
      '你是一个友好的QQ群机器人助手，回答简洁准确，避免敏感内容。',
    AI_TIMEOUT_MS: num(env.AI_TIMEOUT_MS, 30000),
    AI_MAX_CONTEXT: num(env.AI_MAX_CONTEXT, 10),   // 保留最近 N 条上下文
    AI_MAX_TOKENS: num(env.AI_MAX_TOKENS, 800),
    AI_ENABLED: bool(env.AI_ENABLED, true),

    // 广告过滤
    AD_FILTER_ENABLED: bool(env.AD_FILTER_ENABLED, true), // 全局总开关
    AD_ACTION: env.AD_ACTION || 'delete_mute',            // warn | delete | delete_mute
    AD_MUTE_SECONDS: num(env.AD_MUTE_SECONDS, 600),       // 命中后禁言时长
    AD_MUTE_THRESHOLD: num(env.AD_MUTE_THRESHOLD, 3),     // 第 N 次违规才禁言
    AD_MUTE_MAX_SECONDS: num(env.AD_MUTE_MAX_SECONDS, 86400),
    AD_KEYWORDS: list(env.AD_KEYWORDS),                   // 额外关键词
    AD_REGEX: list(env.AD_REGEX, ),                       // 额外正则（分号分隔）

    // 退群拉黑（依赖内邀接口，失败自动忽略）
    LEAVE_BLACKLIST_ENABLED: bool(env.LEAVE_BLACKLIST_ENABLED, false),

    // 管理：openid 白名单（逗号分隔），这些用户可发管理指令
    ADMIN_OPENIDS: list(env.ADMIN_OPENIDS),

    // 管理指令默认禁言上限（秒）
    ADMIN_MAX_MUTE_SECONDS: num(env.ADMIN_MAX_MUTE_SECONDS, 30 * 86400),
  };
}
