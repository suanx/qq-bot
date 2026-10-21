/**
 * 业务处理层
 *  - 消息流水线：管理指令 → 广告检测 → 基础指令 → AI 对话
 *  - 进群欢迎 / 退群拉黑事件
 *  - 群/成员/违规/统计统一落库，供管理后台查询
 */
import { loadConfig } from './config.js';
import { checkAd } from './adfilter.js';
import { recordViolation, decideAction, clearViolations, getViolations } from './moderation.js';
import { replyMessage, recallGroupMessage, muteMember, kickMembers, blacklistMember } from './qqapi.js';
import { createKV } from './kv.js';
import {
  touchGroup, touchMember, logViolation, bumpStat,
  getGroupFlag, setGroupFlag, loadAdminOpenids, loadAdRules,
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
  return /^\/?(广告开|广告关|AI开|AI关|禁言|解禁|踢|拉黑|违规分|清违规|管理|撤回)/i
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
    if (!target) return '用法：/拉黑 @某人（需先移出群）';
    try {
      await blacklistMember(groupOpenid, target, true, cfg);
      await touchMember(kv, groupOpenid, target, { status: 'blacklisted' });
      return '🚫 已加入群黑名单';
    } catch (e) {
      return `拉黑失败：${/11253|权限/.test(e.message) ? '该接口为内邀白名单能力，需联系平台申请' : e.message}`;
    }
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
  const { action, muteSeconds } = decideAction(count, cfg);

  // 修复：真正按 cfg.AD_ACTION 决定执行力度（此前配置被忽略）
  const level = ACTION_LEVEL[String(cfg.AD_ACTION || '').toLowerCase()] ?? 2;

  const actions = [];
  if (level >= 1) {
    try {
      await recallGroupMessage(groupOpenid, ctx.msgId, cfg);
      actions.push('已撤回');
    } catch (e) {
      console.warn('撤回失败:', e.message);
    }
  }
  if (level >= 2 && action === 'mute' && muteSeconds > 0) {
    try {
      await muteMember(groupOpenid, user, muteSeconds, cfg);
      actions.push(`禁言 ${fmtDuration(muteSeconds)}`);
  } catch (e) {
      console.warn('禁言失败:', e.message);
      actions.push('禁言失败（机器人需要群管理员身份）');
    }
  }

  // 落库：违规记录 + 成员档案
  const effectiveAction = level === 0 ? 'warn' : (level === 1 ? 'delete' : (muteSeconds > 0 ? 'delete_mute' : 'delete'));
  await logViolation(kv, {
    groupOpenid,
    memberOpenid: user,
    rule: ctx.adHit.rule,
    matched: ctx.adHit.matched,
    content: ctx.text,
    action: effectiveAction,
    muteSeconds: level >= 2 ? muteSeconds : 0,
    count,
    msgId: ctx.msgId,
  });
  await touchMember(kv, groupOpenid, user, {
    violations: count,
    status: level >= 2 && muteSeconds > 0 ? 'muted' : 'normal',
    mutedUntil: level >= 2 && muteSeconds > 0
      ? new Date(Date.now() + muteSeconds * 1000).toISOString()
      : null,
  });
  await bumpStat(kv, 'violations');

  if (count >= 10) console.warn(`[moderation] ${groupOpenid}/${user} 违规已达 ${count} 次，建议人工处理`);

  return `⚠️ @${user} 检测到广告/违规内容（规则：${ctx.adHit.rule}），第 ${count} 次违规，${actions.join('、') || '请遵守群规'}！`;
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

/** 处理一条消息事件，返回回复计划或 null（不回复） */
export async function handleMessage(evt, rawEnv) {
  const cfg = loadConfig(rawEnv);
  // 驱动解析是异步的（可能动态加载官方 Blob SDK）
  const kv = await createKV(rawEnv);
  const type = evt.t || evt.type || '';
  const d = evt.d || {};
  const author = d.author || {};

  // ---- 非消息事件 ----
  if (type === 'GROUP_ADD_ROBOT') {
    await touchGroup(kv, d.group_openid, { joinedAt: new Date().toISOString() });
    return {
      chatType: 'group', targetId: d.group_openid, msgId: null, msgSeq: 1,
      content: '大家好！我是 AI 助手机器人 🤖\n直接 @我 提问即可对话；发送「帮助」查看指令。',
    };
  }
  if (type === 'GROUP_MEMBER_REMOVE') {
    if (cfg.LEAVE_BLACKLIST_ENABLED && d.group_openid && d.member_openid) {
      try {
        await blacklistMember(d.group_openid, d.member_openid, true, cfg);
        await touchMember(kv, d.group_openid, d.member_openid, { status: 'blacklisted' });
        console.log(`[leave-blacklist] 已拉黑退群成员 ${d.member_openid}`);
      } catch (e) {
        console.warn(`[leave-blacklist] 拉黑失败(需内邀权限): ${e.message}`);
      }
    }
    return null; // 退群不回复
  }
  if (type === 'GROUP_MEMBER_ADD') {
    await touchGroup(kv, d.group_openid);
    await touchMember(kv, d.group_openid, d.member_openid, { status: 'normal' });
    return {
      chatType: 'group', targetId: d.group_openid, msgId: null, msgSeq: 1,
      content: '🎉 欢迎新成员加入！发送「帮助」了解我。',
    };
  }

  // ---- 消息事件 ----
  const isC2C = !d.group_openid;
  const rawContent = String(d.content || '');
  // 修复：先提取 @，再清理正文（此前先清理导致 @ 目标丢失）
  const mentions = extractMentions(rawContent);
  const content = stripMentions(rawContent);
  if (!content) return null;

  const groupOpenid = d.group_openid || null;
  const ctx = {
    chatType: isC2C ? 'c2c' : 'group',
    targetId: groupOpenid || author.user_openid,
    sender: author.user_openid || 'anonymous',
    text: content,
    msgId: d.id,
    mentions,
    msgSeq: 1,
  };
  ctx.scope = ctx.chatType === 'group' ? `g:${ctx.targetId}` : `u:${ctx.sender}`;

  await bumpStat(kv, 'messages');
  if (groupOpenid) await touchGroup(kv, groupOpenid);

  // 1) 管理指令（仅管理员）
  if (isAdminCommand(ctx.text) && await isAdmin(cfg, kv, ctx.sender)) {
    await bumpStat(kv, 'commands');
    if (/^\/?管理$/.test(ctx.text.trim())) return { ...ctx, content: adminHelp() };
    const r = await handleAdminCommand(evt, ctx, cfg, kv);
    if (r) return { ...ctx, content: r };
  }

  // 2) 广告过滤（仅群聊）
  if (cfg.AD_FILTER_ENABLED && ctx.chatType === 'group'
      && await getGroupFlag(kv, ctx.targetId, 'adfilter', true)) {
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

  // 4) AI 对话（带频控）
  if (cfg.AI_ENABLED && cfg.AI_API_KEY
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
