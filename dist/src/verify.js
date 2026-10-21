/**
 * Webhook 请求验签（Web Crypto 版）
 *
 * QQ 机器人 Webhook 模式：请求头携带
 *   X-Signature-Ed25519 : base64(签名)
 *   X-Signature-Timestamp: 时间戳（秒）
 * 签名对象 = timestamp 字符串 + 请求体原文
 * 用开放平台「回调配置」中的 Ed25519 公钥验证
 *
 * 说明：部署在 EdgeOne Pages 边缘函数（V8 运行时），该运行时提供的是
 * 标准 Web Crypto API，不保证有 node:crypto，因此统一用 globalThis.crypto 实现，
 * 保持零依赖。
 */
const crypto = globalThis.crypto;

const DER_PREFIX = new Uint8Array([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

/** base64 -> Uint8Array（兼容含换行的 PEM 片段） */
function b64ToBytes(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 把 base64 / PEM 公钥统一导入为 CryptoKey（异步） */
export async function loadPublicKey(keyStr) {
  if (!keyStr) return null;
  const s = String(keyStr).trim();
  let spki;
  if (s.includes('BEGIN')) {
    // PEM（SPKI）：去掉首尾标记行后再解 base64
    spki = b64ToBytes(s.replace(/-----[^-]+-----/g, ''));
  } else {
    // 原始 32 字节公钥：补 SubjectPublicKeyInfo DER 头
    const raw = b64ToBytes(s);
    if (raw.length !== 32) {
      throw new Error(`公钥长度异常：期望 32 字节，实际 ${raw.length} 字节`);
    }
    spki = new Uint8Array(DER_PREFIX.length + raw.length);
    spki.set(DER_PREFIX);
    spki.set(raw, DER_PREFIX.length);
  }
  return crypto.subtle.importKey('spki', spki, { name: 'Ed25519' }, false, ['verify']);
}

export async function verifyEd25519(publicKey, signatureB64, timestamp, rawBody) {
  if (!publicKey || !signatureB64 || !timestamp) return false;
  const msg = new TextEncoder().encode(String(timestamp) + rawBody);
  const sig = b64ToBytes(signatureB64);
  try {
    return await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, sig, msg);
  } catch {
    return false;
  }
}

/** 时间戳容差校验，防重放 */
export function checkTimestamp(timestamp, toleranceSec = 300) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - ts) <= toleranceSec;
}

/**
 * 入口：校验一次 Webhook 请求。返回 { ok, reason }
 * 注意：为异步接口，调用处需 await。
 */
export async function verifyRequest(request, rawBody, publicKey, tolerance = 300) {
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');

  if (!sig) return { ok: false, reason: 'missing signature' };
  if (!checkTimestamp(ts, tolerance)) return { ok: false, reason: 'timestamp out of tolerance' };
  if (!publicKey) return { ok: false, reason: 'public key not configured' };
  if (!(await verifyEd25519(publicKey, sig, ts, rawBody))) return { ok: false, reason: 'bad signature' };
  return { ok: true };
}

export default { loadPublicKey, verifyEd25519, checkTimestamp, verifyRequest };
