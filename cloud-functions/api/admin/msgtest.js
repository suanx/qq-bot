/**
 * /api/admin/msgtest  消息发送连通性测试（需登录 + 写权限）
 * POST { targetId, chatType='group', content }
 *
 * 服务端用生产配置真实调用 QQ 开放平台 API，返回每一步结果与
 * 平台原始响应，用于定位「机器人不回复」类故障：
 * token 获取失败 / 群权限 / 频控 / 内容审核拦截，错误信息一目了然。
 * 注意：主动消息有平台额度限制，本端点仅供诊断使用。
 */
import { pushMessage } from '../../../src/qqapi.js';
import { loadConfig } from '../../../src/config.js';
import { fail, guard, json } from '../../../src/admin/api.js';

export async function onRequest(context) {
  const { request, env } = context;
  const g = await guard(request, env, { write: true });
  if (g.error) return g.error;
  if (request.method !== 'POST') return fail('仅支持 POST', 405);

  let body = {};
  try { body = await request.json(); } catch { /* 空体 */ }
  const targetId = String(body.targetId || '').trim();
  const chatType = body.chatType === 'c2c' ? 'c2c' : 'group';
  const content = String(body.content || '').trim() || '🔧 管理后台连通性测试';
  if (!targetId) return fail('缺少 targetId（群 openid 或用户 openid）', 400);

  const cfg = loadConfig(env);
  if (cfg.MOCK) return fail('当前为 MOCK 模式，无法真实发送', 400);

  const started = Date.now();
  try {
    const resp = await pushMessage({ targetId, content, chatType }, cfg);
    return json({
      ok: true,
      chatType,
      targetId,
      latencyMs: Date.now() - started,
      resp, // QQ 平台原始响应
    });
  } catch (e) {
    return json({
      ok: false,
      chatType,
      targetId,
      latencyMs: Date.now() - started,
      error: String((e && e.message) || e), // 含 HTTP 状态码与平台错误体
    });
  }
}

export const onRequestPost = onRequest;
