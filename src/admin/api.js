/**
 * 管理后台通用工具：JSON 响应 / 登录守卫 / 分页排序 / 审计日志
 */
import { loadConfig } from '../config.js';
import { createKV } from '../kv.js';
import { createRepo, COLLECTIONS } from '../repo.js';
import { readSession, parseCookies, SESSION_COOKIE, buildCookie } from './auth.js';

export const json = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });

export const ok = (data = {}) => json({ ok: true, ...data });
export const fail = (message, status = 400) => json({ ok: false, error: message }, status);

/** 角色 -> 可写集合（读权限所有登录角色都有） */
const PERMISSIONS = {
  owner: [
    COLLECTIONS.GROUPS, COLLECTIONS.MEMBERS,
    COLLECTIONS.VIOLATIONS, COLLECTIONS.RULES, COLLECTIONS.ADMINS,
    COLLECTIONS.SETTINGS,
  ],
  admin: [
    COLLECTIONS.GROUPS, COLLECTIONS.MEMBERS,
    COLLECTIONS.VIOLATIONS, COLLECTIONS.RULES, COLLECTIONS.SETTINGS,
  ],
  viewer: [],
};

export function canWrite(user, collection) {
  const list = PERMISSIONS[String(user?.role || '').toLowerCase()] || [];
  return list.includes(collection);
}

/** 建立后台上下文（异步：驱动解析可能动态加载可选 SDK） */
export async function context(rawEnv) {
  const cfg = loadConfig(rawEnv);
  const kv = await createKV(rawEnv);
  const repo = createRepo(kv);
  return { cfg, kv, repo };
}

/** 取当前登录用户，未登录返回 null */
export async function currentUser(request, cfg) {
  const cookies = parseCookies(request.headers.get('cookie'));
  return readSession(cookies[SESSION_COOKIE], cfg.ADMIN_SESSION_SECRET);
}

/**
 * 登录 + 权限守卫
 * 返回 { cfg, kv, repo, user } 或 { error: Response }
 */
export async function guard(request, rawEnv, { collection = null, write = false } = {}) {
  const ctx = await context(rawEnv);
  const user = await currentUser(request, ctx.cfg);
  if (!user) return { error: fail('未登录或会话已过期', 401) };
  if (write && collection && !canWrite(user, collection)) {
    return { error: fail('当前角色无此操作权限', 403) };
  }
  return { ...ctx, user };
}

/** 解析分页/排序参数 */
export function paging(request, defaults = {}) {
  const url = new URL(request.url);
  const page = Math.max(1, Number(url.searchParams.get('page')) || defaults.page || 1);
  const pageSize = Math.min(
    100,
    Math.max(1, Number(url.searchParams.get('pageSize')) || defaults.pageSize || 20),
  );
  const sortKey = url.searchParams.get('sortKey') || defaults.sortKey || 'createdAt';
  const rawDir = url.searchParams.get('sortDir') || defaults.sortDir || 'desc';
  return { page, pageSize, sortKey, sortDir: rawDir === 'asc' ? 'asc' : 'desc' };
}

/** 从 query 里挑出允许的业务筛选字段 */
export function pickFilters(request, fields = []) {
  const url = new URL(request.url);
  const out = {};
  fields.forEach((f) => {
    const v = url.searchParams.get(f);
    if (v !== null && v !== '') out[f] = v;
  });
  return out;
}

/** 写入操作日志 */
export async function audit(repo, user, action, target = '', detail = '') {
  return repo.create(COLLECTIONS.LOGS, {
    actor: user?.name || user?.username || 'unknown',
    actorRole: user?.role || '',
    action,
    target: String(target || ''),
    detail: String(detail || ''),
  });
}

/** 会话 Cookie（Secure 可通过 ADMIN_COOKIE_SECURE=0 关闭，便于本地 http 调试） */
export function sessionCookie(cfg, value, maxAge = 0) {
  const secure = String(cfg.ADMIN_COOKIE_SECURE ?? '1').toLowerCase() !== '0';
  return buildCookie(SESSION_COOKIE, value, { maxAge, secure });
}

/** 清除会话 Cookie */
export function clearCookie(cfg) {
  return sessionCookie(cfg, '', 0);
}

export default { json, ok, fail, guard, paging, pickFilters, audit };
