/**
 * POST /api/admin/logout  清除会话 Cookie
 */
import { loadConfig } from '../../../src/config.js';
import { createKV } from '../../../src/kv.js';
import { createRepo } from '../../../src/repo.js';
import { audit, json, clearCookie } from '../../../src/admin/api.js';

export async function onRequest(context) {
  const { request, env } = context;
  const cfg = loadConfig(env);
  const kv = createKV(env);
  const repo = createRepo(kv);

  // 尽力记录：即使会话已失效也不影响退出
  await audit(repo, { name: 'unknown' }, 'logout', '-', '退出登录');

  return json({ ok: true }, 200, { 'Set-Cookie': clearCookie(cfg) });
}

export const onRequestPost = onRequest;
