/**
 * 大模型对话（OpenAI 兼容 /chat/completions）
 * 支持 deepseek / moonshot / 智谱 / openai 等，按群维护上下文
 * 上下文与限流计数统一走 kv 适配层（可持久化）
 */
import { beijingDay } from './records.js';

const MAX_CONTEXT_ITEMS = 20;

function contextKey(scope) { return `aictx:${scope}`; }

/** 读取历史上下文（异步） */
export async function getHistory(kv, scope) {
  return kv.get(contextKey(scope), []);
}

/** 追加一条上下文（异步） */
export async function pushHistory(kv, scope, role, content, keep = 10) {
  const key = contextKey(scope);
  const hist = await kv.get(key, []);
  hist.push({ role, content });
  while (hist.length > Math.min(keep * 2, MAX_CONTEXT_ITEMS)) hist.shift();
  await kv.put(key, hist, 3600); // 1 小时无对话自动清空上下文
  return hist;
}

export async function clearHistory(kv, scope) {
  await kv.del(contextKey(scope));
}

/** 按 Unicode 码点截断，避免切断 emoji */
export function truncate(text, max) {
  const s = String(text ?? '');
  if ([...s].length <= max) return s;
  return [...s].slice(0, max).join('');
}

/**
 * 滑动窗口限流：每 60 秒最多 limit 次
 * 返回 { allowed, remaining }
 */
export async function checkRateLimit(kv, scope, cfg = {}) {
  if (cfg.AI_RATE_LIMIT_ENABLED === false) return { allowed: true, remaining: -1 };
  const limit = Math.max(1, Number(cfg.AI_RATE_LIMIT_PER_MIN) || 10);
  const bucket = Math.floor(Date.now() / 1000 / 60);
  const key = `rl:${scope}:${bucket}`;
  const used = await kv.incr(key, 180);
  const remaining = Math.max(0, limit - used);
  return { allowed: used <= limit, remaining };
}

/**
 * 每日调用预算（成本护栏）
 * limit<=0 表示不限制。返回 { allowed, used, limit }
 */
export async function checkDailyBudget(kv, cfg = {}) {
  const limit = Number(cfg.AI_DAILY_LIMIT) || 0;
  const used = await kv.get(`aibudget:${beijingDay()}`, 0);
  if (limit <= 0) return { allowed: true, used, limit: 0 };
  return { allowed: used < limit, used, limit };
}

/** 记一次 AI 调用，用于每日预算统计 */
export async function bumpBudget(kv) {
  return kv.incr(`aibudget:${beijingDay()}`, 3 * 86400);
}

/** 调用大模型，返回回复文本 */
export async function chat(messages, cfg, fetchImpl = fetch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.AI_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${cfg.AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.AI_API_KEY}`,
      },
      body: JSON.stringify({
        model: cfg.AI_MODEL,
        messages,
        max_tokens: cfg.AI_MAX_TOKENS,
        temperature: 0.8,
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new Error(`AI HTTP ${res.status} ${t.slice(0, 200)}`);
    }
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('AI 返回为空');
    return text;
  } finally {
    clearTimeout(timer);
  }
}

export default {
  getHistory, pushHistory, clearHistory, chat,
  truncate, checkRateLimit, checkDailyBudget, bumpBudget,
};
