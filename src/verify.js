/**
 * Webhook 请求验签
 * QQ 机器人 Webhook 模式：请求头携带
 *   X-Signature-Ed25519 : base64(签名)
 *   X-Signature-Timestamp: 时间戳（秒）
 * 签名对象 = timestamp 字符串 + 请求体原文
 * 用开放平台「回调配置」中的 Ed25519 公钥验证
 */
import crypto from 'node:crypto';

const DER_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** 把 base64 / PEM 公钥统一转成 KeyObject */
export function loadPublicKey(keyStr) {
  if (!keyStr) return null;
  const s = String(keyStr).trim();
  if (s.includes('BEGIN')) {
    return crypto.createPublicKey({ key: s, format: 'pem', type: 'spki' });
  }
  const raw = Buffer.from(s, 'base64');
  if (raw.length !== 32) {
    throw new Error(`公钥长度异常：期望 32 字节，实际 ${raw.length} 字节`);
  }
  const der = Buffer.concat([DER_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

export function verifyEd25519(publicKey, signatureB64, timestamp, rawBody) {
  if (!publicKey || !signatureB64 || !timestamp) return false;
  const msg = Buffer.from(String(timestamp) + rawBody, 'utf8');
  const sig = Buffer.from(signatureB64, 'base64');
  try {
    return crypto.verify(null, msg, publicKey, sig);
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
 */
export function verifyRequest(request, rawBody, publicKey, tolerance = 300) {
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');

  if (!sig) return { ok: false, reason: 'missing signature' };
  if (!checkTimestamp(ts, tolerance)) return { ok: false, reason: 'timestamp out of tolerance' };
  if (!publicKey) return { ok: false, reason: 'public key not configured' };
  if (!verifyEd25519(publicKey, sig, ts, rawBody)) return { ok: false, reason: 'bad signature' };
  return { ok: true };
}
