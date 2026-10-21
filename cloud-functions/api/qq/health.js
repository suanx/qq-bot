/**
 * GET /api/qq/health 健康检查
 * ?diag=1 返回环境变量诊断（仅键名与存在性，绝不含值，可长期保留）
 */
import { handleRequest } from '../../../src/core.js';

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

export async function onRequest(context) {
  const { request, env, ctx } = context;
  const url = new URL(request.url);

  if (url.searchParams.get('diag') === '1') {
    const names = env && typeof env === 'object' ? Object.keys(env).sort() : [];

    // Ed25519 WebCrypto 支持性实测（复现 verify.js 的 importKey 逻辑，不返回任何密钥值）
    const ed25519 = { supported: null, error: null };
    try {
      const b64 = String(env?.CALLBACK_PUBLIC_KEY || '').trim();
      if (!b64) throw new Error('CALLBACK_PUBLIC_KEY 为空');
      const bin = atob(b64);
      const raw = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) raw[i] = bin.charCodeAt(i);
      if (raw.length !== 32) throw new Error(`解码后 ${raw.length} 字节（期望 32）`);
      const prefix = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);
      const spki = new Uint8Array(prefix.length + raw.length);
      spki.set(prefix);
      spki.set(raw, prefix.length);
      const key = await crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
      ed25519.supported = true;
      ed25519.keyType = key?.constructor?.name || 'CryptoKey';
    } catch (e) {
      ed25519.supported = false;
      ed25519.error = String((e && e.message) || e);
    }

    return json({
      ok: true,
      envDiag: {
        envType: typeof env,
        keyCount: names.length,
        keyNames: names,
        callbackKeySet: !!env?.CALLBACK_PUBLIC_KEY,
        callbackKeyLen: (env?.CALLBACK_PUBLIC_KEY || '').length,
        appIdSet: !!env?.APP_ID,
        adminPwdSet: !!env?.ADMIN_PASSWORD,
      },
      ed25519,
    });
  }

  return handleRequest(request, env, ctx);
}

export const onRequestGet = onRequest;
