/**
 * /api/admin/settings  全局文案设置（欢迎词 / 退群提示）
 * GET  读取（无记录时返回内置默认值）
 * PUT  保存（局部更新，只接受白名单字段）
 */
import { guard, ok, fail, audit } from '../../../src/admin/api.js';
import { loadSettings, saveSettings } from '../../../src/records.js';
import { COLLECTIONS } from '../../../src/repo.js';

/** 可写字段白名单 */
const ALLOW_FIELDS = [
  'welcomeEnabled',        // 迎宾/送别总开关
  'memberWelcome',         // 新成员进群欢迎词
  'botWelcome',            // 机器人进群欢迎词
  'leaveNotice',           // 成员退群提示
  'autoBlacklistOnLeave',  // 退群自动拉黑
  'joinRequestEnabled',    // 处理入群申请（GROUP_JOIN_REQUEST）
  'joinAutoApprove',       // 入群申请自动通过
  'joinAutoRejectBlacklist', // 黑名单申请人自动拒绝并写入群黑名单
  'joinNotice',            // 入群申请群内通知文案（支持 {name}/{source}/{time}/{tips}）
  'joinRejectReason',      // 自动拒绝理由
];

const DEFAULTS = {
  welcomeEnabled: true,
  memberWelcome: '',
  botWelcome: '',
  leaveNotice: '',
  autoBlacklistOnLeave: true,
  joinRequestEnabled: true,
  joinAutoApprove: false,
  joinAutoRejectBlacklist: true,
  joinNotice: '',
  joinRejectReason: '',
};

export async function onRequest(context) {
  const { request, env } = context;
  const method = String(request.method || 'GET').toUpperCase();
  const g = await guard(request, env, {
    collection: COLLECTIONS.SETTINGS,
    write: method !== 'GET',
  });
  if (g.error) return g.error;

  if (method === 'GET') {
    const item = await loadSettings(g.kv);
    return ok({ item: { id: 'welcome', ...DEFAULTS, ...item } });
  }

  if (method !== 'PUT' && method !== 'POST') return fail('method not allowed', 405);

  let body;
  try { body = await request.json(); } catch { return fail('bad json', 400); }
  if (!body || typeof body !== 'object') return fail('请求体应为对象', 400);

  const patch = {};
  for (const k of ALLOW_FIELDS) {
    if (body[k] === undefined) continue;
    patch[k] = typeof DEFAULTS[k] === 'boolean' ? !!body[k] : String(body[k]).slice(0, 2000);
  }
  if (!Object.keys(patch).length) return fail('没有可保存的字段', 400);

  const item = await saveSettings(g.kv, patch);
  await audit(g.repo, g.user, 'update', 'settings:welcome', JSON.stringify(patch).slice(0, 400));
  return ok({ item });
}

export const onRequestGet = onRequest;
export const onRequestPut = onRequest;
export const onRequestPost = onRequest;
