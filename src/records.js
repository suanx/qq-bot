/**
 * 业务数据落库：群 / 成员 / 违规记录 / 统计计数 / 群开关 / 管理员
 * 这些数据同时服务于机器人主流程与管理后台，统一走 kv 适配层，
 * 保证后台看到的与机器人用的是同一份数据。
 */
import { createRepo, COLLECTIONS } from './repo.js';

/** 北京时间日期（YYYY-MM-DD），用于「今日」统计 */
export function beijingDay(d = new Date()) {
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 登记/更新群信息（首次出现自动建记录） */
export async function touchGroup(kv, groupOpenid, patch = {}) {
  const repo = createRepo(kv);
  const now = new Date().toISOString();
  const cur = await repo.get(COLLECTIONS.GROUPS, groupOpenid);
  if (!cur) {
    return repo.create(COLLECTIONS.GROUPS, {
      id: groupOpenid,
      name: patch.name || groupOpenid,
      status: 'active',
      aiEnabled: patch.aiEnabled ?? true,
      adFilterEnabled: patch.adFilterEnabled ?? true,
      memberCount: patch.memberCount ?? 0,
      lastActiveAt: now,
      joinedAt: now,
    });
  }
  return repo.update(COLLECTIONS.GROUPS, groupOpenid, { ...patch, lastActiveAt: now });
}

/** 登记/更新成员信息（首次出现自动建记录） */
export async function touchMember(kv, groupOpenid, memberOpenid, patch = {}) {
  const repo = createRepo(kv);
  const now = new Date().toISOString();
  const id = `${groupOpenid}:${memberOpenid}`;
  const cur = await repo.get(COLLECTIONS.MEMBERS, id);
  if (!cur) {
    return repo.create(COLLECTIONS.MEMBERS, {
      id,
      groupOpenid,
      memberOpenid,
      nickname: patch.nickname || memberOpenid,
      violations: patch.violations ?? 0,
      status: patch.status || 'normal',
      mutedUntil: patch.mutedUntil ?? null,
      lastActiveAt: now,
      joinedAt: now,
    });
  }
  return repo.update(COLLECTIONS.MEMBERS, id, { ...patch, lastActiveAt: now });
}

/** 写入一条违规记录（供后台查询/审计） */
export async function logViolation(kv, data) {
  const repo = createRepo(kv);
  return repo.create(COLLECTIONS.VIOLATIONS, {
    groupOpenid: data.groupOpenid || '',
    memberOpenid: data.memberOpenid || '',
    rule: data.rule || '',
    matched: data.matched || '',
    content: data.content || '',
    action: data.action || 'warn',
    muteSeconds: data.muteSeconds ?? 0,
    count: data.count ?? 0,
    msgId: data.msgId || '',
  });
}

/** 写操作日志（机器人自动处置记录，后台「操作日志」可查） */
export async function logAction(kv, data) {
  const repo = createRepo(kv);
  return repo.create(COLLECTIONS.LOGS, {
    actor: data.actor || 'system',
    actorRole: data.actorRole || 'bot',
    action: data.action || '',
    target: data.target || '',
    detail: data.detail || '',
  });
}

/** 统计计数自增（按天 + 累计） */
export async function bumpStat(kv, name, delta = 1) {
  const day = beijingDay();
  await kv.incr(`stat:${name}:${day}`, 8 * 86400);
  await kv.incr(`stat:${name}:total`, 0);
}

/** 读取后台维护的广告规则，供检测时合并使用 */
export async function loadAdRules(kv) {
  const repo = createRepo(kv);
  const rules = await repo.list(COLLECTIONS.RULES);
  const keywords = [];
  const regex = [];
  rules.forEach((r) => {
    if (r.enabled === false) return;
    if (r.type === 'keyword' && r.value) keywords.push(String(r.value));
    else if (r.type === 'regex' && r.value) regex.push(String(r.value));
  });
  return { keywords, regex };
}

/** 读取统计（今日 / 累计） */
export async function readStats(kv, names = ['messages', 'ai', 'violations', 'commands']) {
  const day = beijingDay();
  const today = {};
  const total = {};
  await Promise.all(names.map(async (n) => {
    today[n] = await kv.get(`stat:${n}:${day}`, 0);
    total[n] = await kv.get(`stat:${n}:total`, 0);
  }));
  return { today, total, day };
}

/** 群级开关：读（未设置时取传入默认值），写（管理指令/后台可覆盖） */
export async function getGroupFlag(kv, groupOpenid, name, defaultOn = true) {
  const v = await kv.get(`flag:${groupOpenid}:${name}`, null);
  return v === null || v === undefined ? !!defaultOn : !!v;
}

export async function setGroupFlag(kv, groupOpenid, name, on) {
  await kv.put(`flag:${groupOpenid}:${name}`, !!on);
}

/** 读取群档案（不存在返回 null） */
export async function getGroupDoc(kv, groupOpenid) {
  if (!groupOpenid) return null;
  return createRepo(kv).get(COLLECTIONS.GROUPS, groupOpenid);
}

/** 读取成员档案（不存在返回 null） */
export async function getMemberDoc(kv, groupOpenid, memberOpenid) {
  if (!groupOpenid || !memberOpenid) return null;
  return createRepo(kv).get(COLLECTIONS.MEMBERS, `${groupOpenid}:${memberOpenid}`);
}

/**
 * 全局设置（单条记录，id 固定为 WELCOME，后台「欢迎词设置」可编辑）
 * 字段：welcomeEnabled / memberWelcome / botWelcome / leaveNotice / autoBlacklistOnLeave
 */
export const SETTINGS_WELCOME_ID = 'welcome';

export async function loadSettings(kv) {
  try {
    return (await createRepo(kv).get(COLLECTIONS.SETTINGS, SETTINGS_WELCOME_ID)) || {};
  } catch (e) {
    console.warn('读取设置失败，使用默认值:', e.message);
    return {};
  }
}

export async function saveSettings(kv, patch = {}) {
  const repo = createRepo(kv);
  const cur = await repo.get(COLLECTIONS.SETTINGS, SETTINGS_WELCOME_ID);
  if (!cur) {
    return repo.create(COLLECTIONS.SETTINGS, {
      id: SETTINGS_WELCOME_ID,
      welcomeEnabled: true,
      autoBlacklistOnLeave: true,
      ...patch,
    });
  }
  return repo.update(COLLECTIONS.SETTINGS, SETTINGS_WELCOME_ID, patch);
}

/** 后台管理员 openid 列表（仅启用状态） */
export async function loadAdminOpenids(kv) {
  const repo = createRepo(kv);
  const admins = await repo.list(COLLECTIONS.ADMINS);
  return admins
    .filter((a) => a.status !== 'disabled' && a.openid)
    .map((a) => String(a.openid));
}

export default {
  touchGroup, touchMember, logViolation, bumpStat, readStats,
  beijingDay, getGroupFlag, setGroupFlag, loadAdminOpenids,
  getGroupDoc, getMemberDoc, loadSettings, saveSettings,
};
