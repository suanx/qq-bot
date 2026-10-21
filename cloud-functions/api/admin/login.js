/**
 * POST /api/admin/login
 * 两种凭据：
 *   1) 环境变量超管：ADMIN_USERNAME / ADMIN_PASSWORD -> role=owner
 *   2) 后台账号：admins 集合里带口令的记录 -> role 取记录上的角色
 * 通过则下发 HMAC 签名的会话 Cookie
 */
import { loadConfig } from '../../../src/config.js';
import { createKV } from '../../../src/kv.js';
import { createRepo, COLLECTIONS } from '../../../src/repo.js';
import { verifyPassword, signSession, checkPassword } from '../../../src/admin/auth.js';
import { json, fail, audit, sessionCookie } from '../../../src/admin/api.js';

async function resolveUser(cfg, repo, username, password) {
  // 1) 环境变量超管
  if (cfg.ADMIN_PASSWORD && username === cfg.ADMIN_USERNAME
      && await verifyPassword(password, cfg.ADMIN_PASSWORD)) {
    return { username, role: 'owner' };
  }
  // 2) 后台账号
  const list = await repo.list(COLLECTIONS.ADMINS);
  const rec = list.find((a) => (a.username === username || a.openid === username));
  if (!rec) return null;
  if (String(rec.status).toLowerCase() === 'disabled') return null;
  if (!(await checkPassword(password, rec.salt, rec.passwordHash))) return null;
  return { username, role: String(rec.role || 'admin').toLowerCase() };
}

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== 'POST') return fail('method not allowed', 405);

  const cfg = loadConfig(env);
  const kv = await createKV(env);
  const repo = createRepo(kv);

  let body;
  try { body = await request.json(); } catch { return fail('bad json', 400); }

  const username = String((body && body.username) || '').trim();
  const password = String((body && body.password) || '');
  if (!username || !password) return fail('请输入用户名和密码', 400);

  if (!cfg.ADMIN_SESSION_SECRET) {
    return fail('未配置会话密钥（APP_SECRET 或 ADMIN_SESSION_SECRET）', 503);
  }

  const user = await resolveUser(cfg, repo, username, password);
  if (!user) {
    await audit(repo, { name: username }, 'login_failed', username, '用户名或口令错误');
    return fail('用户名或口令错误', 401);
  }

  const ttl = cfg.ADMIN_SESSION_TTL;
  const token = await signSession({ username, role: user.role }, cfg.ADMIN_SESSION_SECRET, ttl);
  await audit(repo, user, 'login', username, '登录成功');

  return json({ ok: true, username, role: user.role }, 200, {
    'Set-Cookie': sessionCookie(cfg, token, ttl),
  });
}

export const onRequestPost = onRequest;
