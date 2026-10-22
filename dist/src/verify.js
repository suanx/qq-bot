/**
 * Webhook 请求验签 + op=13 回调验证应答（node:crypto 版）
 *
 * 运行平台：EdgeOne Node.js Functions（cloud-functions/，Node 20 运行时）
 *
 * 为什么不用 Web Crypto：EdgeOne 边缘 V8 运行时（functions/）的 WebCrypto
 * 实测不支持 Ed25519（importKey 抛 "Param Invalid"），而 Node 的 crypto
 * 原生支持 Ed25519 的 sign/verify。
 *
 * 官方流程（bot.qq.com/wiki → Webhook 方式 / 安全和授权）：
 * 1. 回调地址验证（op=13）：请求不带签名头，body 为
 *    {"d":{"plain_token":"...","event_ts":"..."},"op":13}；
 *    机器人需用 APP_SECRET 派生的 Ed25519 私钥对
 *    event_ts + plain_token 签名，返回 {"plain_token","signature"(hex)}。
 * 2. 事件推送：请求头携带 X-Signature-Ed25519（hex 编码）/
 *    X-Signature-Timestamp，签名覆盖 timestamp + body；
 *    开发者用 APP_SECRET 派生的公钥验签。
 * 3. 密钥派生（官方算法）：将 secret 重复拼接至 ≥32 字节，取前 32 字节
 *    作为 Ed25519 seed；seed 同时决定公钥与私钥。
 */
import crypto from 'node:crypto';

/** Ed25519 公钥 SPKI DER 前缀（RFC 8410） */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
/** Ed25519 私钥 PKCS#8 DER 前缀（RFC 8410） */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function b64ToBuf(b64) {
  return Buffer.from(String(b64).replace(/\s+/g, ''), 'base64');
}

/**
 * 官方密钥派生：secret 重复拼接至 ≥32 字节，取前 32 字节作为 seed。
 * @param {string} secret 机器人 AppSecret
 * @returns {Buffer} 32 字节 seed
 */
export function deriveSeed(secret) {
  const s = String(secret ?? '');
  if (!s) throw new Error('APP_SECRET 为空，无法派生密钥');
  let seed = Buffer.from(s, 'utf8');
  const one = Buffer.from(s, 'utf8');
  while (seed.length < 32) seed = Buffer.concat([seed, one]);
  return seed.subarray(0, 32);
}

/**
 * 由 secret 派生 Ed25519 私钥（KeyObject），用于 op=13 应答签名。
 */
export function derivePrivateKey(secret) {
  const der = Buffer.concat([PKCS8_PREFIX, deriveSeed(secret)]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

/**
 * 由 secret 派生 Ed25519 公钥（KeyObject），用于事件推送验签。
 * 与 tools/derive-callback-key.mjs 输出的公钥一致。
 */
export function derivePublicKey(secret) {
  const priv = derivePrivateKey(secret);
  return crypto.createPublicKey(priv);
}

/** 把 base64 / PEM 公钥统一转成 KeyObject（兼容外部配置的公钥） */
export function loadPublicKey(keyStr) {
  if (!keyStr) return null;
  const s = String(keyStr).trim();
  if (s.includes('BEGIN')) {
    return crypto.createPublicKey({ key: s, format: 'pem', type: 'spki' });
  }
  const raw = b64ToBuf(s);
  if (raw.length !== 32) {
    throw new Error(`公钥长度异常：期望 32 字节，实际 ${raw.length} 字节`);
  }
  const der = Buffer.concat([SPKI_PREFIX, raw]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * 验证 Ed25519 签名。签名按官方要求为 hex 编码，
 * 同时兼容 base64 编码（历史/第三方实现）。
 */
export function verifyEd25519(publicKey, signatureEnc, timestamp, rawBody) {
  if (!publicKey || !signatureEnc || !timestamp) return false;
  const s = String(signatureEnc).trim();
  let sig = null;
  // 官方为 hex（64 字节签名 → 128 个 hex 字符）
  if (/^[0-9a-fA-F]{128}$/.test(s)) {
    sig = Buffer.from(s, 'hex');
  } else {
    sig = b64ToBuf(s);
  }
  if (sig.length !== 64) return false;
  const msg = Buffer.from(String(timestamp) + rawBody, 'utf8');
  try {
    return crypto.verify(null, msg, publicKey, sig);
  } catch {
    return false;
  }
}

/**
 * op=13 回调验证应答签名：对 event_ts + plain_token 签名，返回 hex。
 * @param {string} secret 机器人 AppSecret
 * @param {string} eventTs 请求体中的 event_ts
 * @param {string} plainToken 请求体中的 plain_token
 * @returns {string} hex 编码签名
 */
export function signValidation(secret, eventTs, plainToken) {
  const msg = Buffer.from(String(eventTs) + String(plainToken), 'utf8');
  return crypto.sign(null, msg, derivePrivateKey(secret)).toString('hex');
}

/** 时间戳容差校验，防重放 */
export function checkTimestamp(timestamp, toleranceSec = 300) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  return Math.abs(Math.floor(Date.now() / 1000) - ts) <= toleranceSec;
}

/**
 * 入口：校验一次 Webhook 请求（事件推送）。返回 { ok, reason }
 * 保持 async 签名与 core.js 的调用方式兼容。
 * 注意：op=13 回调验证请求不带签名头，由 core.js 在调用本函数前分流。
 */
export async function verifyRequest(request, rawBody, publicKey, tolerance = 300) {
  const sig = request.headers.get('x-signature-ed25519');
  const ts = request.headers.get('x-signature-timestamp');

  if (!sig) return { ok: false, reason: 'missing signature' };
  if (!checkTimestamp(ts, tolerance)) return { ok: false, reason: 'timestamp out of tolerance' };
  if (!publicKey) return { ok: false, reason: 'public key not configured' };
  if (!verifyEd25519(publicKey, sig, ts, rawBody)) return { ok: false, reason: 'bad signature' };
  return { ok: true };
}

export default {
  deriveSeed,
  derivePrivateKey,
  derivePublicKey,
  loadPublicKey,
  verifyEd25519,
  signValidation,
  checkTimestamp,
  verifyRequest,
};
