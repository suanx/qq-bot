/**
 * POST /api/admin/aitest  AI 大模型连通性测试
 * 用最小化请求（max_tokens=24）真实调用一次 /chat/completions，
 * 返回 ok/延迟/回复原文或错误原因 —— 用于验证 AI_API_KEY 是否有效。
 * 仅消耗一次极小调用；需登录后台（所有角色可用）。
 */
import { guard, json } from '../../src/admin/api.js';
import { loadConfig } from '../../src/config.js';
import { chat as aiChat } from '../../src/ai.js';

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);

  const g = await guard(request, env, { collection: 'logs', write: false });
  if (g.error) return g.error;

  const cfg = loadConfig(env);
  if (!cfg.AI_API_KEY) {
    return json({ ok: false, reason: 'not_configured', error: '未配置 AI_API_KEY' });
  }

  // 测试专用配置：限输出长度、超时最多放宽到 45s（慢速免费模型也可能 20s+），控制成本
  const testCfg = {
    ...cfg,
    AI_MAX_TOKENS: 24,
    AI_TIMEOUT_MS: Math.min(Number(cfg.AI_TIMEOUT_MS) || 30000, 45000),
  };

  const started = Date.now();
  try {
    const reply = await aiChat(
      [{ role: 'user', content: '请只回复两个字：正常' }],
      testCfg,
    );
    return json({
      ok: true,
      model: cfg.AI_MODEL,
      baseUrl: cfg.AI_BASE_URL,
      latencyMs: Date.now() - started,
      reply: String(reply).slice(0, 120),
    });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e && e.message)));
    return json({
      ok: false,
      model: cfg.AI_MODEL,
      baseUrl: cfg.AI_BASE_URL,
      latencyMs: Date.now() - started,
      error: aborted
        ? `AI 请求超时（>${Math.round(testCfg.AI_TIMEOUT_MS / 1000)}s 无响应）`
        : String((e && e.message) || e),
    });
  }
}

export const onRequestPost = onRequest;
