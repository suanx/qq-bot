/**
 * 业务处理层
 *  - 消息流水线：管理指令 → 广告检测 → AI 对话
 *  - 进群欢迎 / 退群拉黑事件
 */
import { loadConfig } from './config.js';
import { store, groupFlag, setGroupFlag } from './store.js';
import { checkAd } from './adfilter.js';
import { recordViolation, decideAction, clearViolations, getViolations } from './moderation.js';
import { replyMessage, recallGroupMessage, muteMember, kickMembers, blacklistMember } from './qqapi.js';
import * as ai from './ai.js';

/* ---------------- 工具 ---------------- */

const p2 = (n) => String(n).padStart(2, '0');
export function fmtDuration(sec) {
  if (sec % 86400 === 0 && sec >= 86400) return `${sec / 86400} 天`;
  if (sec >= 3600) return `${Math.floor(sec / 3600)}小时${p2(Math.floor((sec % 3600) / 60))}分`;
  if (sec >= 60) return `${Math.floor(sec / 60)} 分钟`;
  return `${sec} 秒`;
}

/** 管理员判断（openid 白名单） */
function isAdmin(cfg, openid) {
  return cfg.ADMIN_OPENIDS.includes(openid);
}

/* ---------------- 管理指令 ---------------- */

function adminHelp() {
  return [
    '🛠 管理指令（仅管理员可用）：',
    '· /广告开 | /广告关 —— 开关广告过滤',
    '· /AI开 | /AI关 —— 开关大模型对话',
    '· /禁言 @某人 时长 —— 禁言（如 /禁言 @张三 10分钟）',
    '· /解禁 @某人 —— 解除禁言',
    '· /撤回 —— 引用回复本条可撤回（回复机器人消息「撤回」）',
    '· /踢 @某人 —— 移出群聊（需内邀权限）',
    '· /拉黑 @某人 —— 加入群黑名单（需内邀权限）',
    '· /违规分 @某人 —— 查询某人违规计数',
    '· /清违规 @某人 —— 清零违规计数',
  ].join('\n');
}

/** 解析时长：10分钟 / 2小时 / 1天 / 600秒 */
function parseDuration(s) {
  const m = String(s || '').trim().match(/^(\d+)\s*(秒|分钟|分|小时|时|天|日)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = m[2] || '分钟';
  const mult = { 秒: 1, 分钟: 60, 分: 60, 小时: 3600, 时: 3600, 天: 86400, 日: 86400 }[unit];
  return n * mult;
}

/** 从消息里提取被 @ 的人（群消息 author 聚合在 d，at 段在 content 之外，这里用文本匹配 + 事件里 members） */
function extractTargetOpenid(evt, text) {
  // QQ v2 群消息事件里，被@用户的 openid 在 d.files / d.members 等字段不统一，
  // 常见实现：content 中 <@openid> 段
  const m = String(text || '').match(/<@!?([A-Za-z0-9]+)>/);
  if (m) return m[1];
  // 事件里可能直接带 at_user_openid / mention 字段
  const d = evt.d || {};
  return d.at_user_openid || d.mention_openid || null;
}

async function handleAdminCommand(evt, ctx, cfg) {
  const text = ctx.text;
  const groupOpenid = ctx.targetId;
  const target = extractTargetOpenid(evt, text);
  const args = text.replace(/<@!?[A-Za-z0-9]+>/g, '').trim();

  // 开关类
  const flagMap = [
    { re: /^\/?广告开$/, flag: 'adfilter', on: true, name: '广告过滤' },
    { re: /^\/?广告关$/, flag: 'adfilter', on: false, name: '广告过滤' },
    { re: /^\/?AI开$/i, flag: 'ai', on: true, name: 'AI 对话' },
    { re: /^\/?AI关$/i, flag: 'ai', on: false, name: 'AI 对话' },
  ];
  for (const f of flagMap) {
    if (f.re.test(text)) {
      setGroupFlag(groupOpenid, f.flag, f.on);
      return `${f.on ? '✅ 已开启' : '⛔ 已关闭'}${f.name}`;
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
    return `🔇 已禁言 ${fmtDuration(sec)}`;
  }
  if (/^\/?解禁/.test(text)) {
    if (!target) return '用法：/解禁 @某人';
    await muteMember(groupOpenid, target, 0, cfg);
    return '🔊 已解除禁言';
  }

  // 踢人 / 拉黑（内邀接口，失败给提示）
  if (/^\/?踢/.test(text)) {
    if (!target) return '用法：/踢 @某人';
    try {
      await kickMembers(groupOpenid, [target], cfg, { addToBlacklist: false });
      return '👢 已移出群聊';
    } catch (e) {
      return `踢人失败：${/11253|权限/.test(e.message) ? '该接口为内邀白名单能力，需联系平台申请' : e.message}`;
    }
  }
  if (/^\/?拉黑/.test(text)) {
    if (!target) return '用法：/拉黑 @某人（需先移出群）';
    try {
      await blacklistMember(groupOpenid, target, true, cfg);
      return '🚫 已加入群黑名单';
    } catch (e) {
      return `拉黑失败：${/11253|权限/.test(e.message) ? '该接口为内邀白名单能力，需联系平台申请' : e.message}`;
    }
  }

  // 违规分
  if (/^\/?违规分/.test(text)) {
    if (!target) return '用法：/违规分 @某人';
    return `📊 该用户当前违规次数：${getViolations(groupOpenid, target)}`;
  }
  if (/^\/?清违规/.test(text)) {
    if (!target) return '用法：/清违规 @某人';
    clearViolations(groupOpenid, target);
    return '🧹 已清零违规计数';
  }

  return null;
}

/* ---------------- 广告检测与处罚 ---------------- */

async function handleAdViolation(evt, ctx, cfg) {
  const groupOpenid = ctx.targetId;
  const user = ctx.sender;
  const count = recordViolation(groupOpenid, user);
  const { action, muteSeconds } = decideAction(count, cfg);

  const actions = [];
  // 撤回（2 分钟内有效；机器人需管理员）
  try {
    await recallGroupMessage(groupOpenid, ctx.msgId, cfg);
    actions.push('已撤回');
  } catch (e) {
    console.warn('撤回失败:', e.message);
  }
  // 禁言（阶梯）
  if (action === 'delete_mute' && muteSeconds > 0) {
    try {
      await muteMember(groupOpenid, user, muteSeconds, cfg);
      actions.push(`禁言 ${fmtDuration(muteSeconds)}`);
    } catch (e) {
      console.warn('禁言失败:', e.message);
      actions.push('禁言失败（机器人需要群管理员身份）');
    }
  }
  clearViolationsOnPardon(cfg, groupOpenid, user, count);

  return `⚠️ @${user} 检测到广告/违规内容（规则：${ctx.adHit.rule}），第 ${count} 次违规，${actions.join('、') || '请遵守群规'}！`;
}

function clearViolationsOnPardon(cfg, group, user, count) {
  // 预留：达到很高次数可升级处理（如踢人），此处记录日志
  if (count >= 10) console.warn(`[moderation] ${group}/${user} 违规已达 ${count} 次，建议人工处理`);
}

/* ---------------- AI 对话 ---------------- */

function shouldChat(text) {
  // 以 / 开头的指令不进 AI
  if (/^\//.test(text.trim())) return false;
  return true;
}

async function handleAIChat(ctx, cfg, evt) {
  const scope = ctx.chatType === 'group' ? `g:${ctx.targetId}` : `u:${ctx.sender}`;
  const hist = ai.getHistory(scope);
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
  ai.pushHistory(scope, 'user', ctx.text, cfg.AI_MAX_CONTEXT);
  ai.pushHistory(scope, 'assistant', answer, cfg.AI_MAX_CONTEXT);
  // QQ 消息长度限制
  return String(answer).slice(0, 1200);
}

/* ---------------- 主流水线 ---------------- */

/** 处理一条消息事件，返回要回复的文本或 null */
export async function handleMessage(evt, rawEnv) {
  const cfg = loadConfig(rawEnv);
  const type = evt.t || evt.type || '';
  const d = evt.d || {};
  const author = d.author || {};

  // ---- 非消息事件 ----
  if (type === 'GROUP_ADD_ROBOT') {
    return {
      chatType: 'group', targetId: d.group_openid, msgId: null,
      content: '大家好！我是 AI 助手机器人 🤖\n直接 @我 提问即可对话；发送「帮助」查看指令。',
    };
  }
  if (type === 'GROUP_MEMBER_REMOVE') {
    // 退群拉黑（内邀接口，未配置/无权限时静默）
    if (cfg.LEAVE_BLACKLIST_ENABLED && d.group_openid && d.member_openid) {
      try {
        await blacklistMember(d.group_openid, d.member_openid, true, cfg);
        console.log(`[leave-blacklist] 已拉黑退群成员 ${d.member_openid}`);
      } catch (e) {
        console.warn(`[leave-blacklist] 拉黑失败(需内邀权限): ${e.message}`);
      }
    }
    return null; // 退群不回复
  }
  if (type === 'GROUP_MEMBER_ADD') {
    return {
      chatType: 'group', targetId: d.group_openid, msgId: null,
      content: `🎉 欢迎新成员加入！发送「帮助」了解我。`,
    };
  }

  // ---- 消息事件 ----
  const isC2C = !d.group_openid;
  const content = String(d.content || '').replace(/@[^@\s]+\s*/g, '').trim();
  if (!content) return null;

  const ctx = {
    chatType: isC2C ? 'c2c' : 'group',
    targetId: d.group_openid || author.user_openid,
    sender: author.user_openid || 'anonymous',
    text: content,
    msgId: d.id,
  };

  // 1) 管理指令（仅白名单）
  if (isAdmin(cfg, ctx.sender) && /^[\/]?[\u4e00-\u9fa5A-Za-z]/.test(ctx.text) && /^\/?(广告|AI|禁言|解禁|踢|拉黑|违规分|清违规|管理)/i.test(ctx.text)) {
    if (/^\/?(管理|help2)$/.test(ctx.text) || /^\/?管理$/.test(ctx.text)) return adminHelp();
    const r = await handleAdminCommand(evt, ctx, cfg);
    if (r) return { ...ctx, content: r };
  }

  // 2) 广告过滤（仅群聊）
  if (cfg.AD_FILTER_ENABLED && ctx.chatType === 'group' && groupFlag(ctx.targetId, 'adfilter', true)) {
    const hit = checkAd(ctx.text, cfg);
    if (hit.hit) {
      ctx.adHit = hit;
      const r = await handleAdViolation(evt, ctx, cfg);
      return { ...ctx, content: r };
    }
  }

  // 3) 基础指令
  const basic = basicCommand(ctx.text);
  if (basic) return { ...ctx, content: basic };

  // 4) AI 对话
  if (cfg.AI_ENABLED && cfg.AI_API_KEY && groupFlag(ctx.targetId, 'ai', true) && shouldChat(ctx.text)) {
    const r = await handleAIChat(ctx, cfg, evt);
    if (r) return { ...ctx, content: r };
  }

  return null;
}

function basicCommand(text) {
  const t = text.trim();
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
