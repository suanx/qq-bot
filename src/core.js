/**
 * 核心处理逻辑，与运行平台解耦。
 * handleRequest(request, env, ctx) -> Response
 */
import { loadConfig } from './config.js';
import { verifyRequest, loadPublicKey } from './verify.js';
import { handleMessage } from './handlers.js';
import { replyMessage } from './qqapi.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

/** 处理一条事件：拿到回复计划后异步发送 */
async function dispatchEvent(evt, rawEnv) {
  try {
    // 统一把原始 env 透传下去，由业务层自行 loadConfig（避免重复加载）
    const plan = await handleMessage(evt, rawEnv);
    if (!plan || !plan.content) return;
    await replyMessage(
      {
        targetId: plan.targetId,
        content: plan.content,
        msgId: plan.msgId,
        msgSeq: plan.msgSeq || 1, // 同一 msg_id 多次回复时需递增
        chatType: plan.chatType,
      },
      loadConfig(rawEnv),
    );
  } catch (e) {
    console.error('处理事件失败:', e.message);
  }
}

export async function handleRequest(request, env = {}, ctx = {}) {
  const url = new URL(request.url);

  // ---------- 健康检查 ----------
  if (request.method === 'GET' && url.pathname.endsWith('/health')) {
    return json({ ok: true, service: 'qq-bot-edgeone', time: new Date().toISOString() });
  }

  if (request.method !== 'POST') {
    return json({ error: 'method not allowed' }, 405);
  }

  const cfg = loadConfig(env);
  const rawBody = await request.text();

  // ---------- Ed25519 验签 ----------
  let publicKey = null;
  try {
    // 修复：loadPublicKey / verifyRequest 现为异步（Web Crypto），必须 await
    publicKey = await loadPublicKey(cfg.CALLBACK_PUBLIC_KEY);
  } catch (e) {
    console.error('公钥加载失败:', e.message);
  }
  const verified = await verifyRequest(request, rawBody, publicKey, cfg.SIGN_TOLERANCE);
  if (!verified.ok) {
    console.warn('拒绝未验签请求:', verified.reason);
    return json({ error: 'unauthorized', reason: verified.reason }, 401);
  }

  // ---------- 解析事件 ----------
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: 'bad json' }, 400); }

  // QQ 平台 Webhook 校验（VALIDATION 回显）
  if (payload.op === 13 && payload.d && payload.d.plainChallenge) {
    console.log('Webhook 校验请求，回显 challenge');
    return json({ plainChallenge: payload.d.plainChallenge });
  }

  const events = Array.isArray(payload) ? payload : [payload];
  const jobs = events
    .map((evt) => dispatchEvent(evt, env))
    .map((p) => p.catch((e) => console.error('事件异常:', e)));

  // 先回 200 防超时重推，消息异步发送
  if (typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(Promise.allSettled(jobs));
  } else {
    Promise.allSettled(jobs).catch(() => {});
  }
  return json({ ok: true });
}

export default { fetch: handleRequest };
