/**
 * 核心处理逻辑，与运行平台解耦。
 * handleRequest(request, env, ctx) -> Response
 *
 * 官方 Webhook 流程（bot.qq.com/wiki）：
 * - op=13：回调地址验证请求，不带签名头；机器人用 APP_SECRET 派生私钥
 *   对 event_ts + plain_token 签名，返回 {"plain_token","signature"(hex)}。
 * - 其余（事件推送）：请求头携带 X-Signature-Ed25519（hex）/ X-Signature-Timestamp，
 *   需验签后再处理。
 */
import { loadConfig } from './config.js';
import { verifyRequest, loadPublicKey, derivePublicKey, signValidation } from './verify.js';
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

/**
 * 取得验签公钥：优先 CALLBACK_PUBLIC_KEY 环境变量，
 * 否则直接由 APP_SECRET 按官方算法派生（官方模型：签名/验签同源）。
 */
async function resolvePublicKey(cfg) {
  if (cfg.CALLBACK_PUBLIC_KEY) {
    try {
      return await loadPublicKey(cfg.CALLBACK_PUBLIC_KEY);
    } catch (e) {
      console.error('CALLBACK_PUBLIC_KEY 加载失败，回退 APP_SECRET 派生:', e.message);
    }
  }
  if (cfg.APP_SECRET) {
    try {
      return derivePublicKey(cfg.APP_SECRET);
    } catch (e) {
      console.error('APP_SECRET 派生公钥失败:', e.message);
    }
  }
  return null;
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

  // ---------- 解析事件（需先看 op 决定验签策略） ----------
  let payload;
  try { payload = JSON.parse(rawBody); } catch { return json({ error: 'bad json' }, 400); }

  // ---------- QQ 平台回调地址验证（op=13，官方规定不带签名头） ----------
  if (payload.op === 13) {
    const d = payload.d || {};
    const plainToken = d.plain_token ?? d.plainToken;
    const eventTs = d.event_ts ?? d.eventTs;
    if (!plainToken || !eventTs) {
      console.error('op=13 校验请求缺少 plain_token/event_ts');
      return json({ error: 'bad validation payload' }, 400);
    }
    if (!cfg.APP_SECRET) {
      console.error('APP_SECRET 未配置，无法应答 op=13 校验');
      return json({ error: 'app secret not configured' }, 500);
    }
    try {
      const signature = signValidation(cfg.APP_SECRET, eventTs, plainToken);
      console.log('Webhook 回调验证请求，已返回签名应答');
      return json({ plain_token: plainToken, signature });
    } catch (e) {
      console.error('op=13 签名失败:', e.message);
      return json({ error: 'sign failed' }, 500);
    }
  }

  // ---------- Ed25519 验签（事件推送） ----------
  const publicKey = await resolvePublicKey(cfg);
  const verified = await verifyRequest(request, rawBody, publicKey, cfg.SIGN_TOLERANCE);
  if (!verified.ok) {
    console.warn('拒绝未验签请求:', verified.reason);
    return json({ error: 'unauthorized', reason: verified.reason }, 401);
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
