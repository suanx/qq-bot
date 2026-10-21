/**
 * 大模型对话（OpenAI 兼容 /chat/completions）
 * 支持 deepseek / moonshot / 智谱 / openai 等，按群维护上下文
 */
import { store } from './store.js';

const MAX_CONTEXT_ITEMS = 20;

function contextKey(scope) { return `aictx:${scope}`; }

export function getHistory(scope) {
  return store.get(contextKey(scope), []);
}

export function pushHistory(scope, role, content, keep = 10) {
  const key = contextKey(scope);
  const hist = store.get(key, []);
  hist.push({ role, content });
  while (hist.length > Math.min(keep * 2, MAX_CONTEXT_ITEMS)) hist.shift();
  store.set(key, hist, 3600); // 1 小时无对话自动清空上下文
}

export function clearHistory(scope) {
  store.del(contextKey(scope));
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
