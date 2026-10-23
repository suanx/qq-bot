/**
 * /api/admin/settings  全局文案设置（欢迎词 / 退群提示）
 * GET  读取（无记录时返回内置默认值）
 * PUT  保存（局部更新，只接受白名单字段）
 */
import { guard, ok, fail, audit } from '../../src/admin/api.js';
import { loadSettings, saveSettings } from '../../src/records.js';
import { COLLECTIONS } from '../../src/repo.js';
import { loadConfig } from '../../src/config.js';

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
  'adAction',              // 违规处置力度 warn | delete | delete_mute
  'adMuteThreshold',       // 第 N 次违规开始禁言
  'adMuteSeconds',         // 首次禁言时长（秒，之后翻倍）
  'adKickThreshold',       // 第 N 次违规踢出群聊并拉黑（0=关闭）
];

/** 数值字段（存数字，空串表示沿用环境变量） */
const NUM_FIELDS = ['adMuteThreshold', 'adMuteSeconds', 'adKickThreshold'];

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
  adAction: '',
  adMuteThreshold: '',
  adMuteSeconds: '',
  adKickThreshold: '',
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
    // effective：当前环境变量层面的生效值，供后台展示「留空时的默认」
    const cfg = loadConfig(env);
    return ok({
      item: { id: 'welcome', ...DEFAULTS, ...item },
      effective: {
        adAction: cfg.AD_ACTION,
        adMuteThreshold: cfg.AD_MUTE_THRESHOLD,
        adMuteSeconds: cfg.AD_MUTE_SECONDS,
        adKickThreshold: cfg.AD_KICK_THRESHOLD,
      },
    });
  }

  if (method !== 'PUT' && method !== 'POST') return fail('method not allowed', 405);

  let body;
  try { body = await request.json(); } catch { return fail('bad json', 400); }
  if (!body || typeof body !== 'object') return fail('请求体应为对象', 400);

  const patch = {};
  for (const k of ALLOW_FIELDS) {
    if (body[k] === undefined) continue;
    if (NUM_FIELDS.includes(k)) {
      const raw = String(body[k]).trim();
      // 空串 = 清除该字段，回退到环境变量
      if (!raw) { patch[k] = ''; continue; }
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 0) return fail(`${k} 应为非负数字`, 400);
      patch[k] = n;
      continue;
    }
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
