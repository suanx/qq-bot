/**
 * GET /api/qq/health 健康检查
 * ?diag=1 返回环境变量诊断（仅键名、长度、指纹，绝不含密钥原文，可长期保留）
 */
import crypto from 'node:crypto';
import { handleRequest } from '../../../src/core.js';
import { derivePublicKey, loadPublicKey } from '../../../src/verify.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

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
      runtime: {
        node: process.version,
        ed25519: fromSecret.ok,
      },
    });
  }

  return handleRequest(request, env, ctx);
}

export const onRequestGet = onRequest;
