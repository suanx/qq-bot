/**
 * /api/admin/admins  后台账号与权限管理（仅 owner 可写）
 * GET  ?id=&search=&role=&status=&page=&pageSize=
 * POST 新建（可带 password 字段设置口令）
 * PUT  ?id= 更新（可带 password 字段改口令，可改 role/status）
 * DELETE ?id= 删除
 * 说明：口令以加盐哈希保存，查询接口不返回 salt/passwordHash。
 */
import { createRepo, COLLECTIONS } from '../../src/repo.js';
import { guard, paging, pickFilters, audit, ok, fail } from '../../src/admin/api.js';
import { makeCredentials } from '../../src/admin/auth.js';

const ROLES = ['owner', 'admin', 'viewer'];
const STATUSES = ['enabled', 'disabled'];

function validate(p, { partial = false, actorRole = 'owner' } = {}) {
  const role = (p.role || (partial ? null : 'admin'));
  if (role !== null && !ROLES.includes(String(role).toLowerCase())) {
    return `role 必须是 ${ROLES.join(' 或 ')}`;
  }
  if (p.status && !STATUSES.includes(String(p.status).toLowerCase())) {
    return `status 必须是 ${STATUSES.join(' 或 ')}`;
  }
  // 防越权：非 owner 不能授予 owner
  if (actorRole !== 'owner' && String(role || '').toLowerCase() === 'owner') {
    return '仅 owner 可授予 owner 角色';
  }
  if (!partial && !p.openid) return '缺少 openid';
  return null;
}

const sanitize = (a) => {
  if (!a) return a;
  const { salt, passwordHash, ...rest } = a;
  return rest;
};

export async function onRequest(context) {
  const { request, env } = context;
  const method = String(request.method || 'GET').toUpperCase();
  const write = method !== 'GET';

  const g = await guard(request, env, { collection: COLLECTIONS.ADMINS, write });
  if (g.error) return g.error;
  const { repo, user } = g;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (method === 'GET') {
    if (id) {
      const item = await repo.get(COLLECTIONS.ADMINS, id);
      return item ? ok({ item: sanitize(item) }) : fail('记录不存在', 404);
    }
    const p = paging(request, { sortKey: 'createdAt', sortDir: 'desc' });
    const result = await repo.query(COLLECTIONS.ADMINS, {
      search: url.searchParams.get('search') || '',
      filters: pickFilters(request, ['role', 'status']),
      searchFields: ['openid', 'name', 'note', 'username'],
      ...p,
    });
    return ok({ ...result, items: result.items.map(sanitize) });
  }

  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return fail('bad json', 400); }
    if (!body || typeof body !== 'object') return fail('请求体应为对象', 400);
    if (!body.openid) return fail('缺少 openid', 400);

    const payload = {
      openid: String(body.openid).trim(),
      name: body.name || '',
      username: body.username || '',
      role: String(body.role || 'admin').toLowerCase(),
      status: String(body.status || 'enabled').toLowerCase(),
      note: body.note || '',
    };
    const err = validate(payload, { actorRole: user.role });
    if (err) return fail(err, 400);

    if (body.password) {
      const creds = await makeCredentials(String(body.password));
      payload.salt = creds.salt;
      payload.passwordHash = creds.passwordHash;
    }
    const item = await repo.create(COLLECTIONS.ADMINS, payload);
    await audit(repo, user, 'create', `admins:${item.id}`, `openid=${payload.openid} role=${payload.role}`);
    return ok({ item: sanitize(item) });
  }

  if (method === 'PUT') {
    if (!id) return fail('缺少 id', 400);
    let body;
    try { body = await request.json(); } catch { return fail('bad json', 400); }
    if (!body || typeof body !== 'object') return fail('请求体应为对象', 400);

    const err = validate(body, { partial: true, actorRole: user.role });
    if (err) return fail(err, 400);

    const patch = { ...body };
    if (patch.role) patch.role = String(patch.role).toLowerCase();
    if (patch.status) patch.status = String(patch.status).toLowerCase();
    if (patch.password) {
      const creds = await makeCredentials(String(patch.password));
      patch.salt = creds.salt;
      patch.passwordHash = creds.passwordHash;
      delete patch.password;
    }
    const item = await repo.update(COLLECTIONS.ADMINS, id, patch);
    if (!item) return fail('记录不存在', 404);
    await audit(repo, user, 'update', `admins:${id}`,
      'role=' + (patch.role || '-') + ' status=' + (patch.status || '-'));
    return ok({ item: sanitize(item) });
  }

  if (method === 'DELETE') {
    if (!id) return fail('缺少 id', 400);
    const item = await repo.remove(COLLECTIONS.ADMINS, id);
    if (!item) return fail('记录不存在', 404);
    await audit(repo, user, 'delete', `admins:${id}`, `openid=${item.openid}`);
    return ok({ item: sanitize(item) });
  }

  return fail('method not allowed', 405);
}

export const onRequestGet = onRequest;
export const onRequestPost = onRequest;
export const onRequestPut = onRequest;
export const onRequestDelete = onRequest;
