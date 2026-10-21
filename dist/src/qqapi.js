/**
 * QQ 开放平台 v2 服务端 API 封装
 *  - Access Token 获取与缓存
 *  - 消息：发送 / 撤回
 *  - 群管理：禁言 / 踢人 / 黑名单（踢人、拉黑为内邀接口，失败自动忽略）
 */

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken';
const API_BASE = 'https://api.sgroup.qq.com';

let tokenCache = { token: '', expiresAt: 0 };

export function _resetTokenCache() { tokenCache = { token: '', expiresAt: 0 }; }

/** RFC3339 北京时间：now + sec 秒 */
export function muteExpireAt(seconds) {
  const t = new Date(Date.now() + seconds * 1000 + 8 * 3600 * 1000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${p2(t.getUTCMonth() + 1)}-${p2(t.getUTCDate())}` +
    `T${p2(t.getUTCHours())}:${p2(t.getUTCMinutes())}:${p2(t.getUTCSeconds())}+08:00`;
}

async function getAccessToken(cfg, fetchImpl = fetch) {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt - 5 * 60 * 1000) return tokenCache.token;
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: cfg.APP_ID, client_secret: cfg.APP_SECRET }),
  });
  if (!res.ok) throw new Error(`获取 access_token 失败: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  if (!data.access_token) throw new Error(`获取 access_token 失败: ${JSON.stringify(data)}`);
  tokenCache = { token: data.access_token, expiresAt: now + (Number(data.expires_in) || 7200) * 1000 };
  return tokenCache.token;
}

/** 统一调用 openapi（MOCK 模式只打印不请求） */
async function callApi(cfg, method, path, body = null, fetchImpl = fetch) {
  if (cfg.MOCK) {
    console.log(`[MOCK] ${method} ${path}`, body ? JSON.stringify(body) : '');
    return { mock: true };
  }
  const token = await getAccessToken(cfg, fetchImpl);
  const res = await fetchImpl(API_BASE + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${cfg.APP_ID}.${token}`,
      'X-Union-Appid': cfg.APP_ID,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    const err = new Error(`openapi ${method} ${path} 失败: HTTP ${res.status} ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const text = await res.text();
  try { return text ? JSON.parse(text) : {}; } catch { return {}; }
}

/* ---------------- 消息 ---------------- */

/** 被动回复（msg_id 5 分钟内有效，同 id 多次回复需递增 msg_seq） */
export async function replyMessage(params, cfg, fetchImpl = fetch) {
  const { targetId, content, msgId, msgSeq = 1, chatType = 'group' } = params;
  const path = chatType === 'c2c'
    ? `/v2/users/${targetId}/messages`
    : `/v2/groups/${targetId}/messages`;
  const body = { content, msg_type: 0 };
  if (msgId) { body.msg_id = msgId; body.msg_seq = msgSeq; }
  return callApi(cfg, 'POST', path, body, fetchImpl);
}

/** 主动消息（无需 msg_id，有额度限制） */
export async function pushMessage(params, cfg, fetchImpl = fetch) {
  const { targetId, content, chatType = 'group' } = params;
  const path = chatType === 'c2c'
    ? `/v2/users/${targetId}/messages`
    : `/v2/groups/${targetId}/messages`;
  return callApi(cfg, 'POST', path, { content, msg_type: 0, msg_id: '', msg_seq: 1 }, fetchImpl);
}

/** 撤回群消息（2 分钟内有效；管理员可撤他人消息） */
export async function recallGroupMessage(groupOpenid, messageId, cfg, fetchImpl = fetch) {
  return callApi(cfg, 'DELETE', `/v2/groups/${groupOpenid}/messages/${messageId}`, null, fetchImpl);
}

/* ---------------- 群管理 ---------------- */

/** 设置群成员禁言（需机器人有群管理员身份，最长 30 天） */
export async function muteMember(groupOpenid, memberOpenid, seconds, cfg, fetchImpl = fetch) {
  const op = seconds <= 0 ? 'del' : 'add';
  const member = { op, member_openid: memberOpenid };
  if (seconds > 0) member.mute_expire_at = muteExpireAt(seconds);
  return callApi(cfg, 'POST', `/v2/groups/${groupOpenid}/restrict_chat_setting`, { members: [member] }, fetchImpl);
}

/** 批量踢人（内邀接口，无权限时抛错由调用方处理） */
export async function kickMembers(groupOpenid, memberOpenids, cfg, opts = {}, fetchImpl = fetch) {
  const body = { member_openids: memberOpenids };
  if (opts.addToBlacklist) body.add_to_member_blacklist = true;
  return callApi(cfg, 'POST', `/v2/groups/${groupOpenid}/batch_remove_members`, body, fetchImpl);
}

/** 群黑名单（内邀接口；仅对不在群中的用户生效） */
export async function blacklistMember(groupOpenid, memberOpenid, add = true, cfg, fetchImpl = fetch) {
  return callApi(cfg, 'POST', `/v2/groups/${groupOpenid}/member_blacklist`,
    { op: add ? 'add' : 'del', member_openids: [memberOpenid] }, fetchImpl);
}
