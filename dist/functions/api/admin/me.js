/**
 * GET /api/admin/me  当前登录用户与权限
 */
import { guard, ok, fail } from '../../../src/admin/api.js';
import { COLLECTIONS } from '../../../src/repo.js';

const WRITABLE = {
  owner: ['groups', 'members', 'violations', 'rules', 'admins'],
  admin: ['groups', 'members', 'violations', 'rules'],
  viewer: [],
};

export async function onRequest(context) {
  const { request, env } = context;
  const g = await guard(request, env, { collection: COLLECTIONS.LOGS, write: false });
  if (g.error) return g.error;

  const role = String(g.user.role || 'viewer').toLowerCase();
  return ok({
    username: g.user.username,
    role,
    permissions: {
      read: true,
      write: WRITABLE[role] || [],
    },
  });
}

export const onRequestGet = onRequest;
