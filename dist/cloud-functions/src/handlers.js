/**
 * 业务处理层
 *  - 消息流水线：管理指令 → 广告检测 → 基础指令 → AI 对话
 *  - 进群欢迎 / 退群拉黑事件
 *  - 群/成员/违规/统计统一落库，供管理后台查询
 */
import { loadConfig } from './config.js';
import { checkAd } from './adfilter.js';
import { recordViolation, decideAction, clearViolations, getViolations } from './moderation.js';
import { replyMessage, recallGroupMessage, muteMember, kickMembers, blacklistMember, approveJoinRequest } from './qqapi.js';
import { createKV } from './kv.js';
import {
  touchGroup, touchMember, logViolation, bumpStat, logAction,
  getGroupFlag, setGroupFlag, loadAdminOpenids, loadAdRules,
  getGroupDoc, getMemberDoc, loadSettings,
  saveJoinRequest, updateJoinRequest, joinRequestId,
} from './records.js';
import * as ai from './ai.js';

/* ---------------- 工具 ---------------- */

const p2 = (n) => String(n).padStart(2, '0');

export function fmtDuration(sec) {
  const s = Math.max(0, Number(sec) || 0);
  if (s >= 86400 && s % 86400 === 0) return `${s / 86400} 天`;
  if (s >= 3600) return `${Math.floor(s / 3600)}小时${p2(Math.floor((s % 3600) / 60))}分`;
  if (s >= 60) return `${Math.floor(s / 60)} 分钟`;
  return `${s} 秒`;
}

/** 后台设置里的正数字段：空值/非法值返回 null（表示沿用环境变量） */
function posNum(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 从原始正文提取被 @ 的 openid。
 * QQ v2 群消息事件中，@ 以 <@openid> 或 <@!openid> 形式出现在 content 内。
 */
export function extractMentions(rawContent) {
  return [...String(rawContent || '').matchAll(/<@!?([A-Za-z0-9_-]+)>/g)].map((m) => m[1]);
}

/**
 * 去掉 @ 段，得到用于展示/语义判定的干净文本。
 * 只剥离 QQ 的 <@openid> 形式；不再粗暴剥离裸 @xxx，避免误伤邮箱等正常文本。
 */
export function stripMentions(rawContent) {
  return String(rawContent || '')
    .replace(/<@!?[A-Za-z0-9_-]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 管理员判断：环境变量白名单 ∪ 后台启用中的管理员
 * （异步，因为后台管理员存在 KV 里）
 */
export async function isAdmin(cfg, kv, openid) {
  if (!openid) return false;
  if (cfg.ADMIN_OPENIDS.includes(openid)) return true;
  try {
    const ids = await loadAdminOpenids(kv);
    return ids.includes(String(openid));
  } catch (e) {
    console.warn('读取后台管理员失败:', e.message);
    return false;
  }
}

/* ---------------- 管理指令 ---------------- */

function adminHelp() {
  return [
    '🛠 管理指令（仅管理员可用）：',
    '· /广告开 | /广告关 —— 开关广告过滤',
    '· /AI开 | /AI关 —— 开关大模型对话',
    '· /禁言 @某人 时长 —— 禁言（如 /禁言 @张三 10分钟）',
    '· /解禁 @某人 —— 解除禁言',
    '· /撤回 —— 引用/回复要撤回的消息后发送',
    '· /踢 @某人 —— 移出群聊（需内邀权限）',
    '· /拉黑 @某人 —— 加入群黑名单（需内邀权限）',
    '· /退群 @某人 —— 退群登记：发退群提示并加入黑名单',
    '· /违规分 @某人 —— 查询某人违规计数',
    '· /清违规 @某人 —— 清零违规计数',
  ].join('\n');
}

/** 解析时长：10分钟 / 2小时 / 1天 / 600秒 */
export function parseDuration(s) {
  const m = String(s || '').trim().match(/^(\d+)\s*(秒|分钟|分|小时|时|天|日)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || '分钟';
  const mult = { 秒: 1, 分钟: 60, 分: 60, 小时: 3600, 时: 3600, 天: 86400, 日: 86400 }[unit];
  return n * mult;
}

/** 是否为管理员指令前缀 */
export function isAdminCommand(text) {
  return /^\/?(广告开|广告关|AI开|AI关|禁言|解禁|踢|拉黑|退群|违规分|清违规|管理|撤回)/i
    .test(String(text || '').trim());
}

async function handleAdminCommand(evt, ctx, cfg, kv) {
  const text = ctx.text.trim();
  const groupOpenid = ctx.targetId;
  // 修复：目标优先取正文里的 @，回落事件字段
  const target = (ctx.mentions && ctx.mentions[0])
    || ((evt.d && (evt.d.at_user_openid || evt.d.mention_openid)) || null);
  const args = text.replace(/<@!?[A-Za-z0-9_-]+>/g, ' ').replace(/\s+/g, ' ').trim();

  // 开关类
  const flagMap = [
    { re: /^\/?广告开$/, flag: 'adfilter', on: true, name: '广告过滤' },
    { re: /^\/?广告关$/, flag: 'adfilter', on: false, name: '广告过滤' },
    { re: /^\/?AI开$/i, flag: 'ai', on: true, name: 'AI 对话' },
    { re: /^\/?AI关$/i, flag: 'ai', on: false, name: 'AI 对话' },
  ];
  for (const f of flagMap) {
    if (f.re.test(text)) {
      await setGroupFlag(kv, groupOpenid, f.flag, f.on);
      // 只写本次真正变更的字段，避免 undefined 覆盖另一路开关
      const patch = {};
      if (f.flag === 'ai') patch.aiEnabled = f.on;
      if (f.flag === 'adfilter') patch.adFilterEnabled = f.on;
      await touchGroup(kv, groupOpenid, patch);
      return `${f.on ? '✅ 已开启' : '⛔ 已关闭'}${f.name}`;
    }
  }

  // 撤回（引用/回复某条消息后）
  if (/^\/?撤回/.test(text)) {
    const ref = evt.d && evt.d.message_reference;
    const refId = ref && (ref.message_id || ref.messageId);
    if (!refId) return '用法：引用/回复要撤回的那条消息，再发送「/撤回」';
    try {
      await recallGroupMessage(groupOpenid, refId, cfg);
      return '🗑️ 已撤回该消息';
    } catch (e) {
      return `撤回失败：${e.message}`;
    }
  }

  // 禁言 / 解禁
  if (/^\/?禁言/.test(text)) {
    if (!target) return '用法：/禁言 @某人 10分钟';
    const durStr = args.replace(/^\/?禁言\s*/, '');
    let sec = parseDuration(durStr);
    if (sec === null) sec = 600;
    sec = Math.min(sec, cfg.ADMIN_MAX_MUTE_SECONDS);
    await muteMember(groupOpenid, target, sec, cfg);
    await touchMember(kv, groupOpenid, target, {
      status: 'muted',
      mutedUntil: new Date(Date.now() + sec * 1000).toISOString(),
    });
    return `🔇 已禁言 ${fmtDuration(sec)}`;
  }
  if (/^\/?解禁/.test(text)) {
    if (!target) return '用法：/解禁 @某人';
    await muteMember(groupOpenid, target, 0, cfg);
    await touchMember(kv, groupOpenid, target, { status: 'normal', mutedUntil: null });
    return '🔊 已解除禁言';
  }

  // 踢人 / 拉黑（内邀接口，失败给提示）
  if (/^\/?踢/.test(text)) {
    if (!target) return '用法：/踢 @某人';
    try {
      await kickMembers(groupOpenid, [target], cfg, { addToBlacklist: false });
      await touchMember(kv, groupOpenid, target, { status: 'kicked' });
      return '👢 已移出群聊';
    } catch (e) {
      return `踢人失败：${/11253|权限/.test(e.message) ? '该接口为内邀白名单能力，需联系平台申请' : e.message}`;
    }
  }
  if (/^\/?拉黑/.test(text)) {
    if (!target) return '用法：/拉黑 @某人';
    let official = false;
    try {
      await blacklistMember(groupOpenid, target, true, cfg);
      official = true;
    } catch (e) {
      // 官方拉黑接口为内邀白名单能力（11253 等），回落本地黑名单
      console.warn('官方拉黑失败，回落本地黑名单:', e.message);
    }
    await touchMember(kv, groupOpenid, target, { status: 'blacklisted' });
    await logAction(kv, {
      actor: ctx.sender, actorRole: 'admin',
      action: official ? 'blacklist' : 'blacklist_local',
      target: `${groupOpenid}/${target}`,
      detail: official ? '加入群黑名单（官方接口）' : '加入机器人黑名单（官方接口未开放，本地生效）',
    });
    return official
      ? '🚫 已加入群黑名单'
      : '🚫 已加入机器人黑名单（平台官方接口未开放，机器人将无视其全部消息）';
  }
  // 退群登记：群内发退群提示并加入黑名单。
  // 平台无「成员退群」事件（群聊体系仅推送机器人自身被移出），无法自动感知，
  // 由管理员手动触发；黑名单后该成员若再入群发言，机器人一律静默忽略。
  // 注：群机器人出站消息不支持 @ 第三人（嵌入标签原样显示，平台硬边界），
  // 被动回复只会自动 @ 被回复者（此处是发指令的管理员），故退群提示用纯文本。
  if (/^\/?退群/.test(text)) {
    if (!target) return '用法：/退群 @某人（发送退群提示并加入黑名单）';
    await touchMember(kv, groupOpenid, target, { status: 'blacklisted' });
    await logAction(kv, {
      actor: ctx.sender, actorRole: 'admin',
      action: 'leave_register',
      target: `${groupOpenid}/${target}`,
      detail: '退群登记：加入机器人黑名单',
    });
    return [
      '👋 有成员已退出群聊。',
      '该成员已加入机器人黑名单，其后续消息将被忽略；',
      '为防止其再次入群，请管理员使用群管理功能将其移出。',
    ].join('\n');
  }

  // 违规分
  if (/^\/?违规分/.test(text)) {
    if (!target) return '用法：/违规分 @某人';
    return `📊 该用户当前违规次数：${await getViolations(kv, groupOpenid, target)}`;
  }
  if (/^\/?清违规/.test(text)) {
    if (!target) return '用法：/清违规 @某人';
    await clearViolations(kv, groupOpenid, target);
    await touchMember(kv, groupOpenid, target, { violations: 0, status: 'normal', mutedUntil: null });
    return '🧹 已清零违规计数';
  }

  return null;
}

/* ---------------- 广告检测与处罚 ---------------- */

/** AD_ACTION 力度等级：warn < delete < delete_mute */
const ACTION_LEVEL = { warn: 0, delete: 1, delete_mute: 2 };

async function handleAdViolation(evt, ctx, cfg, kv) {
  const groupOpenid = ctx.targetId;
  const user = ctx.sender;
  const count = await recordViolation(kv, groupOpenid, user);

  // 后台「群设置」里的违规处置参数优先于环境变量（保存即生效，无需重新部署）
  const settings = await loadSettings(kv).catch(() => ({}));
  const eff = {
    ...cfg,
    AD_ACTION: String(settings.adAction || '').trim() || cfg.AD_ACTION,
    AD_MUTE_THRESHOLD: posNum(settings.adMuteThreshold) ?? cfg.AD_MUTE_THRESHOLD,
    AD_MUTE_SECONDS: posNum(settings.adMuteSeconds) ?? cfg.AD_MUTE_SECONDS,
    AD_KICK_THRESHOLD: (settings.adKickThreshold === undefined || settings.adKickThreshold === '')
      ? cfg.AD_KICK_THRESHOLD
      : Math.max(0, Number(settings.adKickThreshold) || 0),
  };

  const { action, muteSeconds } = decideAction(count, eff);
  // 第 N 次（默认 4）直接踢出群聊并拉黑，优先级高于禁言
  const isKick = action === 'kick';

  // 修复：真正按 AD_ACTION 决定执行力度（此前配置被忽略）
  const level = ACTION_LEVEL[String(eff.AD_ACTION || '').toLowerCase()] ?? 2;

  const actions = [];
  // 撤回不再在此处立即执行：警告回复以违规消息的 msg_id 做被动回复，
  // 若先撤回，引用的消息不存在会导致回复发送失败。
  // 改为标记 recallMsgId，由 core.js 在警告回复成功后再撤回（先警告后撤回）。
  if (level >= 1 && ctx.msgId) ctx.recallMsgId = ctx.msgId;
  if (level >= 2 && action === 'mute' && muteSeconds > 0) {
    try {
      await muteMember(groupOpenid, user, muteSeconds, cfg);
      actions.push(`禁言 ${fmtDuration(muteSeconds)}`);
      await logAction(kv, {
        action: 'mute',
        target: `${groupOpenid}/${user}`,
        detail: `第${count}次违规禁言 ${fmtDuration(muteSeconds)}`,
      });
  } catch (e) {
      console.warn('禁言失败:', e.message);
      actions.push('禁言失败（机器人需要群管理员身份）');
      // 失败原因落日志，后台「操作日志」可直接查看（此前只 console.warn 生产不可见）
      await logAction(kv, {
        action: 'mute_failed',
        target: `${groupOpenid}/${user}`,
        detail: `第${count}次违规禁言失败：${e.message}`,
      });
    }
  }

  if (isKick) {
    // 踢人必须在警告发出之后执行（core.js 收到 kickAfterReply 再调用），
    // 否则成员先被移出群，被动回复会因目标不在群而发送失败。
    ctx.kickAfterReply = { memberOpenids: [user], addToBlacklist: true, count };
    await logAction(kv, {
      action: 'kick_planned',
      target: `${groupOpenid}/${user}`,
      detail: `第${count}次违规，警告后踢出群聊并拉黑`,
    });
  }

  // 落库：违规记录 + 成员档案
  const muteApplied = !isKick && level >= 2 && muteSeconds > 0;
  const effectiveAction = isKick
    ? 'kick'
    : (level === 0 ? 'warn' : (level === 1 ? 'delete' : (muteSeconds > 0 ? 'delete_mute' : 'delete')));
  await logViolation(kv, {
    groupOpenid,
    memberOpenid: user,
    rule: ctx.adHit.rule,
    matched: ctx.adHit.matched,
    content: ctx.text,
    action: effectiveAction,
    muteSeconds: muteApplied ? muteSeconds : 0,
    count,
    msgId: ctx.msgId,
  });
  await touchMember(kv, groupOpenid, user, {
    violations: count,
    nickname: ctx.senderName || undefined,
    status: isKick ? 'blacklisted' : (muteApplied ? 'muted' : 'normal'),
    mutedUntil: muteApplied
      ? new Date(Date.now() + muteSeconds * 1000).toISOString()
      : null,
  });
  await bumpStat(kv, 'violations');

  if (count >= 10) console.warn(`[moderation] ${groupOpenid}/${user} 违规已达 ${count} 次，建议人工处理`);

  // 警告文案：@昵称 为纯文本前缀（平台硬边界：群机器人出站消息不支持 @ 第三人，
  // 嵌入 <@openid> / <qqbot-at-user> 都会原样显示）。昵称取事件 author.username。
  const at = `@${ctx.senderName || '该成员'}`;
  if (isKick) {
    return `${at} ⚠️ 你发送的内容违反群规（第 ${count} 次），已被移出群聊并加入黑名单。`;
  }
  const actionText = actions.length ? `，${actions.join('、')}` : (level >= 1 ? '，消息将被撤回' : '');
  return `${at} ⚠️ 你发送的内容违反群规（第 ${count} 次）${actionText}，请遵守群规！`;
}

/* ---------------- AI 对话 ---------------- */

/** 以 / 开头的指令不进 AI */
export function shouldChat(text) {
  return !/^\//.test(String(text || '').trim());
}

async function handleAIChat(ctx, cfg, kv) {
  const scope = ctx.scope;
  const hist = await ai.getHistory(kv, scope);
  const messages = [
    { role: 'system', content: cfg.AI_SYSTEM_PROMPT },
    ...hist,
    { role: 'user', content: ctx.text },
  ];
  let answer;
  try {
    answer = await ai.chat(messages, cfg);
  } catch (e) {
    console.error('AI 调用失败:', e.message);
    return null; // AI 失败静默，不打扰群聊
  }
  await ai.pushHistory(kv, scope, 'user', ctx.text, cfg.AI_MAX_CONTEXT);
  await ai.pushHistory(kv, scope, 'assistant', answer, cfg.AI_MAX_CONTEXT);
  await ai.bumpBudget(kv);
  await bumpStat(kv, 'ai');
  // 修复：按码点截断，避免切断 emoji
  return ai.truncate(answer, 1200);
}

/* ---------------- 主流水线 ---------------- */

/* ---------------- 迎宾 / 送别文案（后台可自定义） ---------------- */

const DEFAULT_MEMBER_WELCOME = '🎉 欢迎新成员加入本群！\n有问题可以直接 @我 提问，发送「帮助」查看指令。';
const DEFAULT_BOT_WELCOME = '大家好！我是 AI 助手机器人 🤖\n直接 @我 提问即可对话；发送「帮助」查看指令。';
const DEFAULT_LEAVE_NOTICE = '👋 有成员退出了群聊，欢迎下次再来～';
const DEFAULT_JOIN_NOTICE = '📥 收到入群申请：{name}\n来源：{source} · 时间：{time}{tips}\n请管理员在后台「入群申请」中审批（通过 / 拒绝）。';
const DEFAULT_JOIN_REJECT_REASON = '该账号在机器人黑名单中，暂不接受入群';

const JOIN_SOURCE_LABEL = { self_apply: '主动申请', invited: '被邀请' };

const ENV_NOTICE_MAP = {
  memberWelcome: 'WELCOME_MEMBER',
  botWelcome: 'WELCOME_BOT',
  leaveNotice: 'LEAVE_NOTICE',
  joinNotice: 'JOIN_NOTICE',
};

/** 模板占位符替换：{name} / {openid} / {source} / {time} / {tips} */
export function fillTemplate(tpl, vars = {}) {
  return String(tpl || '').replace(/\{(\w+)\}/g,
    (all, k) => (vars[k] === undefined || vars[k] === null ? all : String(vars[k])));
}

/** RFC3339 -> 北京时间 YYYY-MM-DD HH:mm（不可解析返回空串） */
function fmtClock(iso) {
  const t = Date.parse(String(iso || ''));
  if (!Number.isFinite(t)) return '';
  const b = new Date(t + 8 * 3600 * 1000);
  return `${b.getUTCFullYear()}-${p2(b.getUTCMonth() + 1)}-${p2(b.getUTCDate())} `
    + `${p2(b.getUTCHours())}:${p2(b.getUTCMinutes())}`;
}

/**
 * 文案取值优先级：群级自定义 > 后台全局设置 > 环境变量 > 内置默认
 * @param {'memberWelcome'|'botWelcome'|'leaveNotice'} field
 */
async function resolveNotice(kv, cfg, groupOpenid, field, fallback) {
  try {
    const group = await getGroupDoc(kv, groupOpenid);
    const gv = group && group[field];
    if (gv && String(gv).trim()) return String(gv).trim();
  } catch (e) { console.warn('读取群级文案失败:', e.message); }
  try {
    const s = await loadSettings(kv);
    if (s[field] && String(s[field]).trim()) return String(s[field]).trim();
  } catch (e) { console.warn('读取全局文案设置失败:', e.message); }
  const ev = cfg[ENV_NOTICE_MAP[field]];
  if (ev && String(ev).trim()) return String(ev).trim();
  return fallback;
}

/** 开关取值：后台设置 > 环境变量 */
async function noticeToggle(kv, cfg, name) {
  try {
    const s = await loadSettings(kv);
    if (s[name] !== undefined && s[name] !== null && s[name] !== '') return !!s[name];
  } catch { /* 忽略，走环境变量默认 */ }
  if (name === 'autoBlacklistOnLeave') return !!cfg.AUTO_BLACKLIST_ON_LEAVE;
  return !!cfg.WELCOME_ENABLED;
}

/** 处理一条消息事件，返回回复计划或 null（不回复） */
export async function handleMessage(evt, rawEnv) {
  const cfg = loadConfig(rawEnv);
  // 驱动解析是异步的（可能动态加载官方 Blob SDK）
  const kv = await createKV(rawEnv);
  const type = evt.t || evt.type || '';
  const d = evt.d || {};
  const author = d.author || {};

  // ---- 非消息事件 ----
  // 机器人被拉进群：发欢迎语（文案可在后台「欢迎词设置」自定义）
  if (type === 'GROUP_ADD_ROBOT') {
    await touchGroup(kv, d.group_openid, { joinedAt: new Date().toISOString() });
    if (!(await noticeToggle(kv, cfg, 'welcomeEnabled'))) return null;
    return {
      chatType: 'group', targetId: d.group_openid, msgId: null, msgSeq: 1,
      content: await resolveNotice(kv, cfg, d.group_openid, 'botWelcome', DEFAULT_BOT_WELCOME),
    };
  }

  // 新成员进群：欢迎 + 建档（GROUP_MEMBER_ADD，Intent GROUP_MEMBER_EVENT 1<<24，
  // 需在 QQ 开放平台「事件订阅」勾选「群成员加入」后才会推送）
  if (type === 'GROUP_MEMBER_ADD') {
    const g = d.group_openid;
    const m = d.member_openid || d.user_openid || '';
    if (!g) return null;
    if (m) {
      // 事件到达即落日志：便于后台自证「进群事件是否真的推送过来了」
      await logAction(kv, {
        action: 'member_join', target: `${g}:${m}`,
        detail: '收到 GROUP_MEMBER_ADD 事件（新成员进群）',
      }).catch(() => {});
      const prev = await getMemberDoc(kv, g, m).catch(() => null);
      if (prev && prev.status === 'blacklisted') {
        // 黑名单成员重新入群：保留黑名单状态并提示管理员（平台无入群拦截 API）
        await logAction(kv, {
          action: 'blacklist_rejoin', target: `${g}:${m}`,
          detail: '黑名单成员重新入群',
        }).catch(() => {});
        return {
          chatType: 'group', targetId: g, msgId: null, msgSeq: 1,
          content: '⚠️ 一名黑名单成员重新加入了本群，请管理员注意核实（平台不提供入群拦截接口）。',
        };
      }
      await touchMember(kv, g, m, { status: 'normal' }).catch(() => {});
    }
    if (!(await noticeToggle(kv, cfg, 'welcomeEnabled'))) return null;
    return {
      chatType: 'group', targetId: g, msgId: null, msgSeq: 1,
      content: await resolveNotice(kv, cfg, g, 'memberWelcome', DEFAULT_MEMBER_WELCOME),
    };
  }

  // 成员退出/被移出群：发退群提示 +（默认）自动拉黑
  if (type === 'GROUP_MEMBER_REMOVE') {
    const g = d.group_openid;
    const m = d.member_openid || d.user_openid || '';
    if (!g || !m) return null;
    await logAction(kv, {
      action: 'member_leave', target: `${g}:${m}`,
      detail: '收到 GROUP_MEMBER_REMOVE 事件（成员退出）',
    }).catch(() => {});
    if (await noticeToggle(kv, cfg, 'autoBlacklistOnLeave')) {
      try {
        await touchMember(kv, g, m, { status: 'blacklisted' });
        await logAction(kv, {
          action: 'blacklist_auto', target: `${g}:${m}`, detail: '成员退群，自动加入机器人黑名单',
        });
      } catch (e) {
        console.warn('退群自动拉黑失败:', e.message);
      }
    }
    if (!(await noticeToggle(kv, cfg, 'welcomeEnabled'))) return null;
    return {
      chatType: 'group', targetId: g, msgId: null, msgSeq: 1,
      content: await resolveNotice(kv, cfg, g, 'leaveNotice', DEFAULT_LEAVE_NOTICE),
    };
  }

  // 用户申请加群：GROUP_JOIN_REQUEST（Intent GROUP_MEMBER_EVENT 1<<24）
  // 平台限制：只有机器人是群管理员时才会推送；这是「黑名单拦在门外」唯一可靠的时机——
  // 可 decline 并把申请人写入平台群黑名单，比入群后再处理有效得多。
  if (type === 'GROUP_JOIN_REQUEST') {
    const g = d.group_openid;
    const m = d.member_openid || d.user_openid || '';
    if (!g || !m) return null;
    const settings = await loadSettings(kv).catch(() => ({}));
    if (settings.joinRequestEnabled === false) return null;

    const name = String(d.username || '').trim() || m;
    const jrId = String(d.join_request_id || '');
    const riskTips = String(d.risk_tips || '');
    const applySource = String(d.apply_source || '');
    const applyAt = d.apply_at ? String(d.apply_at) : new Date().toISOString();
    const recId = joinRequestId(g, m);

    const prev = await getMemberDoc(kv, g, m).catch(() => null);
    const blacklisted = !!(prev && prev.status === 'blacklisted');
    // 黑名单：自动拒绝 + 写入平台群黑名单（默认开启）
    const autoReject = blacklisted && settings.joinAutoRejectBlacklist !== false;
    // 可选自动通过：非黑名单、无风险提示、非机器人账号（默认关闭，避免误放人）
    const autoApprove = !blacklisted && settings.joinAutoApprove === true && !d.bot && !riskTips;

    await saveJoinRequest(kv, {
      groupOpenid: g, memberOpenid: m, username: name, joinRequestId: jrId,
      applySource, invitedBy: String(d.invited_by || ''), riskTips,
      isBot: !!d.bot, applyAt, status: 'pending',
    }).catch((e) => console.warn('记录入群申请失败:', e.message));

    if (autoReject) {
      const reason = String(settings.joinRejectReason || '').trim() || DEFAULT_JOIN_REJECT_REASON;
      try {
        await approveJoinRequest(g, m, 'decline', cfg, {
          joinRequestId: jrId, rejectReason: reason, addToBlacklist: true,
        });
        await updateJoinRequest(kv, recId, { status: 'declined', handledBy: 'auto:blacklist', reason })
          .catch(() => {});
        await logAction(kv, {
          action: 'join_declined', target: `${g}:${m}`,
          detail: `黑名单申请人自动拒绝并写入群黑名单：${name}`,
        }).catch(() => {});
      } catch (e) {
        await logAction(kv, {
          action: 'join_decline_failed', target: `${g}:${m}`,
          detail: `自动拒绝失败：${e.message}（需机器人是群管理员且接口已开通）`,
        }).catch(() => {});
      }
      return null; // 静默拒绝，不在群里刷提示
    }

    if (autoApprove) {
      try {
        await approveJoinRequest(g, m, 'approve', cfg, { joinRequestId: jrId });
        await updateJoinRequest(kv, recId, { status: 'approved', handledBy: 'auto' }).catch(() => {});
        await touchMember(kv, g, m, { status: 'normal', nickname: name }).catch(() => {});
        await logAction(kv, {
          action: 'join_approved', target: `${g}:${m}`, detail: `自动通过入群申请：${name}`,
        }).catch(() => {});
      } catch (e) {
        await logAction(kv, {
          action: 'join_approve_failed', target: `${g}:${m}`, detail: `自动通过失败：${e.message}`,
        }).catch(() => {});
      }
      return null;
    }

    // 默认：只通知管理员（群里发一条提示，去后台审批）
    await logAction(kv, {
      action: 'join_request', target: `${g}:${m}`,
      detail: `收到入群申请：${name}${riskTips ? `（风险提示：${riskTips}）` : ''}`,
    }).catch(() => {});
    const tpl = await resolveNotice(kv, cfg, g, 'joinNotice', DEFAULT_JOIN_NOTICE);
    return {
      chatType: 'group', targetId: g, msgId: null, msgSeq: 1,
      content: fillTemplate(tpl, {
        name,
        openid: m,
        source: JOIN_SOURCE_LABEL[applySource] || applySource || '未知',
        time: fmtClock(applyAt) || '-',
        tips: riskTips ? `\n⚠️ 平台风险提示：${riskTips}` : '',
      }),
    };
  }

  // 机器人被移出群聊：标记群为停用（保留数据供审计），不回复
  if (type === 'GROUP_DEL_ROBOT') {
    if (d.group_openid) {
      await touchGroup(kv, d.group_openid, { status: 'inactive' });
      console.log(`[group-del-robot] 机器人被移出群 ${d.group_openid}，已标记 inactive`);
    }
    return null;
  }
  // 用户添加机器人好友：发一条 c2c 引导语（无 msg_id，属主动消息，失败静默）
  if (type === 'FRIEND_ADD') {
    const uid = d.user_openid || d.openid || (d.author && d.author.user_openid);
    if (!uid) return null;
    return {
      chatType: 'c2c', targetId: uid, msgId: null, msgSeq: 1,
      content: '感谢添加！我可以在群里 @我 对话，也可以直接在这里私聊提问～发送「帮助」查看指令。',
    };
  }
  // 用户删除机器人好友：静默，不回复
  if (type === 'FRIEND_DEL') {
    return null;
  }

  // ---- 消息事件 ----
  const isC2C = !d.group_openid;
  const rawContent = String(d.content || '');
  // 修复：先提取 @，再清理正文（此前先清理导致 @ 目标丢失）
  const mentions = extractMentions(rawContent);
  const content = stripMentions(rawContent);
  if (!content) return null;

  // 修复：群消息事件的发言人标识是 author.member_openid（user_openid 仅 c2c 事件有），
  // 此前只读 user_openid 导致群里全部记成 anonymous，管理员判定/成员登记/违规记录全部失效
  const senderId = author.user_openid || author.member_openid
    || d.user_openid || d.member_openid || null;

  const groupOpenid = d.group_openid || null;
  const ctx = {
    chatType: isC2C ? 'c2c' : 'group',
    targetId: groupOpenid || senderId,
    sender: senderId || 'anonymous',
    // 发言人昵称（群消息事件 author.username，官方 User 结构自带；用于警告文案 @昵称）
    senderName: String(author.username || '').trim(),
    text: content,
    msgId: d.id,
    mentions,
    msgSeq: 1,
  };
  ctx.scope = ctx.chatType === 'group' ? `g:${ctx.targetId}` : `u:${ctx.sender}`;

  await bumpStat(kv, 'messages');
  if (groupOpenid) {
    await touchGroup(kv, groupOpenid);
    // 登记发言人进成员库（首次自动建档），后台「成员管理」可查 openid / 昵称
    const memberDoc = await touchMember(
      kv, groupOpenid, ctx.sender,
      ctx.senderName ? { nickname: ctx.senderName } : {},
    );
    // 本地黑名单：被拉黑成员的消息一律静默忽略（官方拉黑接口为内邀能力，此处兜底生效）
    if (memberDoc && memberDoc.status === 'blacklisted') {
      console.log(`[blacklist] 忽略黑名单成员消息 ${groupOpenid}/${ctx.sender}`);
      return null;
    }
  }

  // 1) 管理指令（仅管理员）
  if (isAdminCommand(ctx.text) && await isAdmin(cfg, kv, ctx.sender)) {
    await bumpStat(kv, 'commands');
    if (/^\/?管理$/.test(ctx.text.trim())) return { ...ctx, content: adminHelp() };
    const r = await handleAdminCommand(evt, ctx, cfg, kv);
    if (r) return { ...ctx, content: r };
  }
  // 1b) 明确是管理指令语法（以 / 开头）但无权限：给出显式反馈而非静默落入 AI 聊天
  //     （不带 / 的中文关键词如「踢足球」不提示，避免误伤普通聊天）
  else if (isAdminCommand(ctx.text) && /^\//.test(ctx.text.trim())) {
    return {
      ...ctx,
      content: '⛔ 该指令仅群管理员可用。若你应是管理员，请让群主在后台「管理员与权限」中登记你当前账号的 openid。',
    };
  }

  // 2) 广告过滤（仅群聊；管理员豁免）
  if (cfg.AD_FILTER_ENABLED && ctx.chatType === 'group'
      && await getGroupFlag(kv, ctx.targetId, 'adfilter', true)
      && !(await isAdmin(cfg, kv, ctx.sender))) {
    // 合并后台动态规则与环境变量规则
    const dynamicRules = await loadAdRules(kv);
    const hit = checkAd(ctx.text, cfg, dynamicRules);
    if (hit.hit) {
      ctx.adHit = hit;
      const r = await handleAdViolation(evt, ctx, cfg, kv);
      return { ...ctx, content: r };
    }
  }

  // 3) 基础指令
  const basic = basicCommand(ctx.text);
  if (basic) {
    await bumpStat(kv, 'commands');
    return { ...ctx, content: basic };
  }

  // 4) AI 对话（带频控；总开关三层：后台「群设置」> 环境变量 AI_ENABLED > 群级 /AI开·/AI关）
  const gset = await loadSettings(kv).catch(() => ({}));
  if (cfg.AI_ENABLED && cfg.AI_API_KEY
      && gset.aiChatEnabled !== false
      && await getGroupFlag(kv, ctx.targetId, 'ai', true)
      && shouldChat(ctx.text)) {
    // 成本护栏 1：每分钟频次
    const rl = await ai.checkRateLimit(kv, ctx.scope, cfg);
    if (!rl.allowed) {
      return { ...ctx, content: `⏳ 提问太频繁啦，请稍后再试（每分钟 ${cfg.AI_RATE_LIMIT_PER_MIN} 次）。` };
    }
    // 成本护栏 2：每日预算上限
    const budget = await ai.checkDailyBudget(kv, cfg);
    if (!budget.allowed) {
      console.warn(`[ai-budget] 今日调用已达上限 ${budget.used}/${budget.limit}`);
      return { ...ctx, content: `🚫 今日 AI 调用已用完（上限 ${budget.limit} 次），明天再来吧～` };
    }
    const r = await handleAIChat(ctx, cfg, kv);
    if (r) return { ...ctx, content: r };
  }

  return null;
}

export function basicCommand(text) {
  const t = String(text || '').trim();
  if (/^(帮助|help|菜单|\/help)$/i.test(t)) {
    return [
      '🤖 我可以做什么：',
      '· 直接发消息即可和 AI 对话',
      '· ping —— 测试在线',
      '· 时间 —— 北京时间',
      '· 复读 xxx —— 复读你说的话',
      '· /管理 —— 管理员指令列表',
    ].join('\n');
  }
  if (/^ping$/i.test(t)) return `pong 🏓 ${new Date().toISOString()}`;
  if (/^(时间|date|\/time)$/i.test(t)) {
    const d = new Date(Date.now() + 8 * 3600 * 1000);
    const week = '日一二三四五六'[d.getUTCDay()];
    return `北京时间：${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} 星期${week} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
  }
  if (/^复读\s+/.test(t)) return t.slice(3).trim() || '复读什么呢？';
  return null;
}

export default { handleMessage, fmtDuration, parseDuration, basicCommand, extractMentions };
