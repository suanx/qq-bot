/**
 * 管理后台鉴权：口令校验 + HMAC 签名会话
 * 仅使用 Web Crypto（边缘运行时可用），保持零依赖
 */
const crypto = globalThis.crypto;
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes) {
  const arr = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '==='.slice((s.length + 3) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    'raw', enc.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify'],
  );
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest('SHA-256', enc.encode(String(text)));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 定长比较，抗时序侧信道 */
export function timingSafeEqual(a, b) {
  const x = String(a);
  const y = String(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/** 环境变量超管口令校验（定长比较，抗时序侧信道） */
export async function verifyPassword(input, expected) {
  if (!expected) return false;                 // 未配置口令时一律拒绝
  const a = await sha256Hex(input);
  const b = await sha256Hex(expected);
  return timingSafeEqual(a, b);
}

/* ---------------- 后台账号口令（加盐哈希） ---------------- */

export function randomSalt() {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export async function hashPassword(password, salt) {
  return sha256Hex(`${salt}:${password}`);
}

/** 生成可落库的凭据（不保存明文） */
export async function makeCredentials(password) {
  const salt = randomSalt();
  const passwordHash = await hashPassword(password, salt);
  return { salt, passwordHash };
}

/** 校验后台账号口令 */
export async function checkPassword(password, salt, expectedHash) {
  if (!salt || !expectedHash) return false;
  const h = await hashPassword(password, salt);
  return timingSafeEqual(h, expectedHash);
}

/** 会话签名：base64url(payload).base64url(hmac) */
export async function signSession(payload, secret, ttlSec) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const bodyB64 = b64urlEncode(enc.encode(JSON.stringify(body)));
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(bodyB64));
  return `${bodyB64}.${b64urlEncode(sig)}`;
}

/** 读取并校验会话，失效返回 null */
export async function readSession(token, secret) {
  if (!token || !secret) return null;
  const [bodyB64, sigB64] = String(token).split('.');
  if (!bodyB64 || !sigB64) return null;
  try {
    const key = await hmacKey(secret);
    const sig = b64urlDecode(sigB64);
    const ok = await crypto.subtle.verify('HMAC', key, sig, enc.encode(bodyB64));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(b64urlDecode(bodyB64)));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx < 0) return;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  });
  return out;
}

export const SESSION_COOKIE = 'bot_admin_session';

export function buildCookie(name, value, opts = {}) {
  const {
    maxAge = 0, httpOnly = true, sameSite = 'Lax', path = '/', secure = true,
  } = opts;
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, `SameSite=${sameSite}`];
  parts.push(`Max-Age=${Math.max(0, maxAge)}`);
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  return parts.join('; ');
}
