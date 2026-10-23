/**
 * 集合式数据访问层（基于 KV 适配层）
 *  - 实体键：col:<集合>:<id>
 *  - 索引键：idx:<集合>（id 数组，新的在前）
 * 提供：list / get / create / update / remove / query（搜索 + 筛选 + 排序 + 分页）
 */

const MAX_INDEX = 5000; // 索引上限，防止无限增长

export function createRepo(kv) {
  const colKey = (name, id) => `col:${name}:${id}`;
  const idxKey = (name) => `idx:${name}`;

  async function readIndex(name) {
    const ids = await kv.get(idxKey(name), []);
    return Array.isArray(ids) ? ids : [];
  }

  async function writeIndex(name, ids) {
    await kv.put(idxKey(name), ids.slice(0, MAX_INDEX));
  }

  /** 全量列表 */
  async function list(name) {
    const ids = await readIndex(name);
    const items = await Promise.all(ids.map((id) => kv.get(colKey(name, id))));
    return items.filter(Boolean);
  }

  async function get(name, id) {
    return kv.get(colKey(name, id), null);
  }

  /** 新建（可自带 id，否则自动生成） */
  async function create(name, entity) {
    const id = entity.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const rec = { ...entity, id, createdAt: entity.createdAt || now, updatedAt: now };
    await kv.put(colKey(name, id), rec);
    const ids = await readIndex(name);
    await writeIndex(name, [id, ...ids.filter((x) => x !== id)]);
    return rec;
  }

  /** 局部更新，不存在返回 null */
  async function update(name, id, patch) {
    const cur = await kv.get(colKey(name, id), null);
    if (!cur) return null;
    const rec = {
      ...cur, ...patch,
      id,                                   // 主键不可改
      createdAt: cur.createdAt,
      updatedAt: new Date().toISOString(),
    };
    await kv.put(colKey(name, id), rec);
    return rec;
  }

  async function remove(name, id) {
    const cur = await kv.get(colKey(name, id), null);
    await kv.del(colKey(name, id));
    const ids = await readIndex(name);
    await writeIndex(name, ids.filter((x) => x !== id));
    return cur;
  }

  /** 清空（测试/重置用） */
  async function clear(name) {
    const ids = await readIndex(name);
    await Promise.all(ids.map((id) => kv.del(colKey(name, id))));
    await kv.del(idxKey(name));
    return ids.length;
  }

  /**
   * 查询：关键词搜索 + 字段筛选 + 排序 + 分页
   * opts: { search, filters, searchFields, sortKey, sortDir, page, pageSize }
   * 返回: { items, total, page, pageSize, totalPages }
   */
  async function query(name, opts = {}) {
    const {
      search = '', filters = {}, searchFields = [],
      sortKey = 'createdAt', sortDir = 'desc',
      page = 1, pageSize = 20,
    } = opts;

    let items = await list(name);

    const q = String(search || '').trim().toLowerCase();
    if (q) {
      items = items.filter((it) =>
        searchFields.some((f) => String(it[f] ?? '').toLowerCase().includes(q)));
    }

    items = items.filter((it) =>
      Object.entries(filters).every(([k, v]) =>
        v === '' || v === undefined || v === null || String(it[k]) === String(v)));

    items.sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      if (av === bv) return 0;
      return (av > bv ? 1 : -1) * (sortDir === 'asc' ? 1 : -1);
    });

    const total = items.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const start = (page - 1) * pageSize;
    return { items: items.slice(start, start + pageSize), total, page, pageSize, totalPages };
  }

  return { list, get, create, update, remove, clear, query, colKey, idxKey };
}

/** 业务集合名常量 */
export const COLLECTIONS = {
  GROUPS: 'groups',
  MEMBERS: 'members',
  VIOLATIONS: 'violations',
  RULES: 'rules',
  ADMINS: 'admins',
  LOGS: 'logs',
  SETTINGS: 'settings',   // 全局配置（欢迎词、退群提示等）
  JOIN_REQUESTS: 'joinrequests', // 入群申请（GROUP_JOIN_REQUEST 事件落库）
};

export default createRepo;
