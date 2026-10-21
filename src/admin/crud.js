/**
 * 集合 CRUD 处理器
 *  - 列表：关键词搜索 + 字段筛选 + 排序 + 分页
 *  - 详情 / 新建 / 更新 / 删除
 * 统一做登录守卫、角色权限校验与操作日志。
 */
import { guard, paging, pickFilters, audit, ok, fail } from './api.js';

/**
 * @param {object} context   EdgeOne EventContext { request, env, ctx }
 * @param {string} collection 集合名
 * @param {object} opts
 *   searchFields   参与关键词搜索的字段
 *   filterFields   允许精确筛选的字段
 *   defaults       新建时的默认字段
 *   validateCreate 新建校验，返回错误字符串或 null
 *   validateUpdate 更新校验
 *   readonlyMethods 禁止的方法（如 logs 禁止 POST/PUT）
 */
export async function handleCollection(context, collection, opts = {}) {
  const { request, env } = context;
  const {
    searchFields = [],
    filterFields = [],
    defaults = {},
    sortKey = 'createdAt',
    sortDir = 'desc',
    validateCreate = null,
    validateUpdate = null,
    deny = [],
    allowClientId = false,   // 群/成员用业务主键，允许客户端指定 id
  } = opts;

  const method = String(request.method || 'GET').toUpperCase();
  const write = method !== 'GET';

  if (deny.map((m) => m.toUpperCase()).includes(method)) {
    return fail('该集合不支持此操作', 405);
  }

  const g = await guard(request, env, { collection, write });
  if (g.error) return g.error;
  const { repo, user } = g;

  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (method === 'GET') {
    if (id) {
      const item = await repo.get(collection, id);
      if (!item) return fail('记录不存在', 404);
      return ok({ item });
    }
    const p = paging(request, { sortKey, sortDir });
    const result = await repo.query(collection, {
      search: url.searchParams.get('search') || '',
      filters: pickFilters(request, filterFields),
      searchFields,
      ...p,
    });
    return ok(result);
  }

  if (method === 'POST') {
    let body;
    try { body = await request.json(); } catch { return fail('bad json', 400); }
    if (!body || typeof body !== 'object') return fail('请求体应为对象', 400);
    const payload = { ...defaults, ...body };
    const err = validateCreate ? validateCreate(payload) : null;
    if (err) return fail(err, 400);
    if (allowClientId && payload.id) payload.id = String(payload.id).trim();
    else delete payload.id;                  // 主键由服务端生成
    payload.createdAt = payload.createdAt || new Date().toISOString();
    const item = await repo.create(collection, payload);
    await audit(repo, user, 'create', `${collection}:${item.id}`,
      JSON.stringify(payload).slice(0, 500));
    return ok({ item });
  }

  if (method === 'PUT') {
    if (!id) return fail('缺少 id', 400);
    let body;
    try { body = await request.json(); } catch { return fail('bad json', 400); }
    if (!body || typeof body !== 'object') return fail('请求体应为对象', 400);
    const err = validateUpdate ? validateUpdate(body) : null;
    if (err) return fail(err, 400);
    const item = await repo.update(collection, id, body);
    if (!item) return fail('记录不存在', 404);
    await audit(repo, user, 'update', `${collection}:${id}`,
      JSON.stringify(body).slice(0, 500));
    return ok({ item });
  }

  if (method === 'DELETE') {
    if (!id) return fail('缺少 id', 400);
    const item = await repo.remove(collection, id);
    if (!item) return fail('记录不存在', 404);
    await audit(repo, user, 'delete', `${collection}:${id}`, '');
    return ok({ item });
  }

  return fail('method not allowed', 405);
}

export default { handleCollection };
