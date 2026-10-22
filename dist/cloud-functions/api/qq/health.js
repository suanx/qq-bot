/**
 * GET /api/qq/health 健康检查
 * ?diag=1 返回环境变量诊断（仅键名、长度、指纹，绝不含密钥原文，可长期保留）
 */
import crypto from 'node:crypto';
import { handleRequest } from '../../src/core.js';
import { derivePublicKey, loadPublicKey } from '../../src/verify.js';
import { loadConfig } from '../../src/config.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

/** 探测一个 URL 的可达性（GET，限时），返回 {status, latencyMs, error} */
async function probe(url, timeoutMs = 8000) {
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return { status: res.status, latencyMs: Date.now() - started, error: null };
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    return {
      status: null,
      latencyMs: Date.now() - started,
      error: aborted ? `超时(${timeoutMs}ms)` : String((e && e.message) || e),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 公钥指纹：raw 32 字节的 SHA-256 前 12 位 hex，仅用于比对，无法反推密钥 */
function fingerprint(keyObj) {
  if (!keyObj) return null;
  try {
    const raw = keyObj.export({ format: 'der', type: 'spki' }).subarray(-32);
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
  } catch {
    return null;
  }
}

export async function onRequest(context) {
  const { request, env, ctx } = context;
  const url = new URL(request.url);

  if (url.searchParams.get('diag') === '1') {
    const names = env && typeof env === 'object' ? Object.keys(env).sort() : [];

    // 1) APP_SECRET 派生公钥的能力 + 指纹（op=13 应答签名靠它）
    const fromSecret = { ok: false, fingerprint: null, error: null };
    try {
      if (!env?.APP_SECRET) throw new Error('APP_SECRET 未配置');
      fromSecret.fingerprint = fingerprint(derivePublicKey(env.APP_SECRET));
      fromSecret.ok = !!fromSecret.fingerprint;
    } catch (e) {
      fromSecret.error = String((e && e.message) || e);
    }

    // 2) 显式配置的 CALLBACK_PUBLIC_KEY 指纹（事件验签用）
    const fromEnvKey = { set: false, fingerprint: null, error: null };
    try {
      const v = String(env?.CALLBACK_PUBLIC_KEY || '').trim();
      fromEnvKey.set = !!v;
      if (!v) throw new Error('未配置（事件验签将回退 APP_SECRET 派生）');
      fromEnvKey.fingerprint = fingerprint(loadPublicKey(v));
      fromEnvKey.ok = !!fromEnvKey.fingerprint;
    } catch (e) {
      fromEnvKey.error = String((e && e.message) || e);
    }

    // 3) 两者是否同源（不同源说明 APP_SECRET 与配置公钥不匹配，必然验签失败）
    const sameKey =
      fromSecret.fingerprint && fromEnvKey.fingerprint
        ? fromSecret.fingerprint === fromEnvKey.fingerprint
        : null;

    // 4) 出网连通性探测（?egress=1 触发，均为 GET 只读固定地址，无 SSRF 风险）
    let egress = null;
    if (url.searchParams.get('egress') === '1') {
      const cfg = loadConfig(env);
      const [aiModels, qqApi] = await Promise.all([
        probe(`${cfg.AI_BASE_URL}/models`),
        probe('https://api.sgroup.qq.com'),
      ]);
      egress = { aiGateway: { url: cfg.AI_BASE_URL, ...aiModels }, qqApi };
    }

    return json({
      ok: true,
      envDiag: {
        keyCount: names.length,
        keyNames: names,
        appIdSet: !!env?.APP_ID,
        appSecretSet: !!env?.APP_SECRET,
        appSecretLen: (env?.APP_SECRET || '').length,
        appSecretLooksPlaceholder: /^(test|local|demo|dev|placeholder|xxx)/i.test(
          String(env?.APP_SECRET || ''),
        ),
        callbackKeySet: !!env?.CALLBACK_PUBLIC_KEY,
        callbackKeyLen: (env?.CALLBACK_PUBLIC_KEY || '').length,
        adminPwdSet: !!env?.ADMIN_PASSWORD,
        adminUsername: String(env?.ADMIN_USERNAME || 'admin（默认）'),
        ai: {
          enabled: env?.AI_ENABLED !== undefined ? env?.AI_ENABLED !== '0' : true,
          apiKeySet: !!env?.AI_API_KEY,
          apiKeyLen: (env?.AI_API_KEY || '').length,
          baseUrl: String(env?.AI_BASE_URL || 'https://api.deepseek.com/v1（默认）'),
          model: String(env?.AI_MODEL || 'deepseek-chat（默认）'),
          dailyLimit: String(env?.AI_DAILY_LIMIT ?? '0=不限（默认）'),
          systemPromptSet: !!env?.AI_SYSTEM_PROMPT,
        },
      },
      keys: { fromSecret, fromEnvKey, sameKey },
      egress,
      runtime: {
        node: process.version,
        ed25519: fromSecret.ok,
      },
    });
  }

  return handleRequest(request, env, ctx);
}

export const onRequestGet = onRequest;
