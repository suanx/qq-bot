/**
 * 自测：覆盖配置 / 验签 / 广告过滤 / 违规处罚 / 存储层 / 业务流水线 / 入口
 * 用法： npm test
 */
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { loadPublicKey, verifyEd25519, checkTimestamp, verifyRequest, derivePublicKey, deriveSeed, derivePrivateKey } from '../src/verify.js';
import { checkAd } from '../src/adfilter.js';
import { decideAction, recordViolation, getViolations, clearViolations } from '../src/moderation.js';
import { createKV } from '../src/kv.js';
import { createRepo, COLLECTIONS } from '../src/repo.js';
import { handleMessage, fmtDuration, parseDuration, extractMentions, stripMentions } from '../src/handlers.js';
import { handleRequest } from '../src/core.js';
import { memoryDriver } from '../src/store.js';
import { signSession, SESSION_COOKIE } from '../src/admin/auth.js';
import { onRequest as aitestHandler } from '../cloud-functions/api/admin/aitest.js';
import { onRequest as msgtestHandler } from '../cloud-functions/api/admin/msgtest.js';
import { onRequest as settingsHandler } from '../cloud-functions/api/admin/settings.js';
import { onRequest as joinrequestsHandler } from '../cloud-functions/api/admin/joinrequests.js';
import { saveSettings, touchGroup, touchMember, saveJoinRequest } from '../src/records.js';
import { verifyAppIdCandidate } from '../src/qqapi.js';

const ncrypto = (await import('node:crypto')).default;
const enc = new TextEncoder();

/* ---------------- 极简测试框架 ---------------- */
let passed = 0;
let failed = 0;
const lines = [];

async function t(name, fn) {
  memoryDriver._clear();
  try {
    await fn();
    passed += 1;
    lines.push(`  PASS  ${name}`);
  } catch (e) {
    failed += 1;
    lines.push(`  FAIL  ${name} -> ${e.message}`);
  }
}

/** 捕获 console.log / console.warn 输出 */
async function captureLogs(fn) {
  const logs = [];
  const orig = { log: console.log, warn: console.warn, error: console.error };
  const push = (...a) => logs.push(a.map(String).join(' '));
  console.log = push;
  console.warn = push;
  console.error = push;
  try { await fn(); } finally {
    console.log = orig.log;
    console.warn = orig.warn;
    console.error = orig.error;
  }
  return logs;
}

const b64 = (bytes) => {
  const arr = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
};

const baseEnv = {
  APP_ID: 'test-app',
  APP_SECRET: 'test-secret',
  MOCK: 'true',
  AI_ENABLED: 'false',
  ADMIN_OPENIDS: 'ADMIN1',
};

const evt = (type, d) => ({ op: 0, t: type, d });
const groupMsg = (content, user = 'U1', group = 'G1', id = 'M1') =>
  evt('GROUP_AT_MESSAGE_CREATE', { group_openid: group, id, content, author: { user_openid: user } });

/* ================= 配置 ================= */
console.log('\n[配置 config]');
await t('默认大模型地址与模型与 README 一致', () => {
  const c = loadConfig({});
  assert.equal(c.AI_BASE_URL, 'https://api.deepseek.com/v1');
  assert.equal(c.AI_MODEL, 'deepseek-chat');
});
await t('布尔值解析', () => {
  assert.equal(loadConfig({ MOCK: '1' }).MOCK, true);
  assert.equal(loadConfig({ MOCK: 'off' }).MOCK, false);
  assert.equal(loadConfig({}).MOCK, false);
});
await t('数值与列表解析', () => {
  const c = loadConfig({ AD_MUTE_SECONDS: 'abc', ADMIN_OPENIDS: 'a, b;c' });
  assert.equal(c.AD_MUTE_SECONDS, 600);
  assert.deepEqual(c.ADMIN_OPENIDS, ['a', 'b', 'c']);
});
await t('AI 限流默认开启', () => {
  assert.equal(loadConfig({}).AI_RATE_LIMIT_ENABLED, true);
  assert.equal(loadConfig({}).AI_RATE_LIMIT_PER_MIN, 10);
});

/* ================= 验签 ================= */
console.log('\n[验签 verify]');
let kp;
await t('生成密钥对成功', async () => {
  kp = ncrypto.generateKeyPairSync('ed25519');
  assert.ok(kp.privateKey);
});
await t('loadPublicKey 支持 base64 原始公钥', async () => {
  const raw = kp.publicKey.export({ format: 'der', type: 'spki' }).slice(-32);
  const key = await loadPublicKey(b64(raw));
  assert.ok(key);
});
await t('loadPublicKey 支持 PEM', async () => {
  const spki = kp.publicKey.export({ format: 'der', type: 'spki' });
  const pem = `-----BEGIN PUBLIC KEY-----\n${b64(spki)}\n-----END PUBLIC KEY-----`;
  const key = await loadPublicKey(pem);
  assert.ok(key);
});
await t('公钥长度异常时抛错', async () => {
  assert.throws(() => loadPublicKey(b64(new Uint8Array(10))));
});
await t('官方 DEMO 一致性：seed 派生（secret→32字节）', () => {
  // 官方《安全和授权》DEMO：secret=naOC0ocQE3shWLAfffVLB1rhYPG7 → seed 末 4 字节为 "naOC"
  const seed = deriveSeed('naOC0ocQE3shWLAfffVLB1rhYPG7');
  assert.equal(seed.length, 32);
  assert.equal(seed.toString('utf8'), 'naOC0ocQE3shWLAfffVLB1rhYPG7naOC');
});
await t('官方 DEMO 一致性：派生公钥逐字节一致 + 签名自洽', () => {
  // 官方 DEMO 输出的公钥字节：[215 195 98 254 ... 103 58]
  const officialPubHex = 'd7c362fe78aef81ff23287b493628b5db02a3c4fe30b215e4d19609b5d76673a';
  const secret = 'naOC0ocQE3shWLAfffVLB1rhYPG7';
  const pub = derivePublicKey(secret);
  assert.equal(pub.export({ format: 'der', type: 'spki' }).slice(-32).toString('hex'), officialPubHex);
  // 签名往返自洽（hex 编码验签）
  const body = '{ "op": 0,"d": {}, "t": "GATEWAY_EVENT_NAME"}';
  const ts = '1725442341';
  const sig = ncrypto.sign(null, Buffer.from(ts + body, 'utf8'), derivePrivateKey(secret)).toString('hex');
  assert.equal(sig.length, 128);
  assert.equal(verifyEd25519(pub, sig, ts, body), true);
});
await t('hex 与 base64 签名均可验签', async () => {
  const key = await loadPublicKey(b64(kp.publicKey.export({ format: 'der', type: 'spki' }).slice(-32)));
  const ts = String(Math.floor(Date.now() / 1000));
  const body = '{"op":0}';
  const sig = ncrypto.sign(null, Buffer.from(ts + body, 'utf8'), kp.privateKey);
  assert.equal(await verifyEd25519(key, sig.toString('hex'), ts, body), true);   // 官方 hex
  assert.equal(await verifyEd25519(key, b64(sig), ts, body), true);              // 兼容 base64
  assert.equal(await verifyEd25519(key, b64(sig), ts, body + 'x'), false);
});
await t('时间戳容差', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal(checkTimestamp(String(now), 300), true);
  assert.equal(checkTimestamp(String(now - 1000), 300), false);
  assert.equal(checkTimestamp('abc', 300), false);
});
await t('verifyRequest：缺签名 / 过期 / 无公钥 / 正常', async () => {
  const key = await loadPublicKey(b64(kp.publicKey.export({ format: 'der', type: 'spki' }).slice(-32)));
  const mk = (hdrs) => new Request('https://x/api/qq/webhook', { method: 'POST', headers: hdrs, body: '{"op":0}' });
  const r1 = await verifyRequest(mk({}), '{"op":0}', key);
  assert.equal(r1.ok, false);
  assert.equal(r1.reason, 'missing signature');

  const old = mk({ 'x-signature-ed25519': 'x', 'x-signature-timestamp': String(Math.floor(Date.now() / 1000) - 999) });
  const r2 = await verifyRequest(old, '{"op":0}', key);
  assert.equal(r2.reason, 'timestamp out of tolerance');

  const r3 = await verifyRequest(mk({ 'x-signature-ed25519': 'x', 'x-signature-timestamp': String(Math.floor(Date.now() / 1000)) }), '{"op":0}', null);
  assert.equal(r3.reason, 'public key not configured');

  const ts = String(Math.floor(Date.now() / 1000));
  const sig = b64(ncrypto.sign(null, Buffer.from(ts + '{"op":0}', 'utf8'), kp.privateKey));
  const r4 = await verifyRequest(mk({ 'x-signature-ed25519': sig, 'x-signature-timestamp': ts }), '{"op":0}', key);
  assert.equal(r4.ok, true);
});

/* ================= 广告过滤 ================= */
console.log('\n[广告过滤 adfilter]');
const cfgEmpty = loadConfig({});
await t('命中 url', () => assert.equal(checkAd('看这里 https://a.com/b', cfgEmpty).rule, 'url'));
await t('命中 tencent-link', () => assert.equal(checkAd('qun.qq 群', cfgEmpty).rule, 'tencent-link'));
await t('命中 contact', () => assert.equal(checkAd('加我vx: abcd1234', cfgEmpty).rule, 'contact'));
await t('命中 money-bait', () => assert.equal(checkAd('免费领取扫码', cfgEmpty).rule, 'money-bait'));
await t('命中 flood', () => assert.equal(checkAd('aaaaaaaaaaaa', cfgEmpty).rule, 'flood'));
await t('命中 invite', () => assert.equal(checkAd('群号: 1234567', cfgEmpty).rule, 'invite'));
await t('正常消息不命中', () => assert.equal(checkAd('今天天气不错', cfgEmpty).hit, false));
await t('自定义关键词', () => {
  const c = loadConfig({ AD_KEYWORDS: '菠菜,博彩' });
  assert.equal(checkAd('来玩菠菜', c).rule, 'keyword');
});
await t('自定义正则', () => {
  const c = loadConfig({ AD_REGEX: '代考.*包过' });
  assert.equal(checkAd('代考四六级包过', c).rule, 'regex');
});
await t('后台动态规则优先生效', () => {
  assert.equal(checkAd('动态关键词', cfgEmpty, { keywords: ['动态关键词'] }).hit, true);
});

/* ================= 违规处罚 ================= */
console.log('\n[违规处罚 moderation]');
await t('阈值前仅警告', () => {
  assert.deepEqual(decideAction(1, cfgEmpty), { action: 'warn', muteSeconds: 0 });
  assert.deepEqual(decideAction(2, cfgEmpty), { action: 'warn', muteSeconds: 0 });
});
await t('达阈值后阶梯禁言（未到踢出阈值）', () => {
  assert.equal(decideAction(3, cfgEmpty).muteSeconds, 600);
});
await t('踢出阈值：第 4 次返回 kick', () => {
  assert.deepEqual(decideAction(4, cfgEmpty), { action: 'kick', muteSeconds: 0 });
  assert.deepEqual(decideAction(9, cfgEmpty), { action: 'kick', muteSeconds: 0 });
});
await t('AD_KICK_THRESHOLD=0 关闭踢出', () => {
  const c = loadConfig({ AD_KICK_THRESHOLD: '0' });
  assert.equal(decideAction(4, c).action, 'mute');
  assert.equal(decideAction(20, c).muteSeconds, c.AD_MUTE_MAX_SECONDS);
});
await t('封顶生效', () => {
  const c = loadConfig({ AD_KICK_THRESHOLD: '0' });
  assert.equal(decideAction(20, c).muteSeconds, c.AD_MUTE_MAX_SECONDS);
});
await t('违规计数 记录/读取/清零', async () => {
  const kv = await createKV({});
  assert.equal(await recordViolation(kv, 'G1', 'U1'), 1);
  assert.equal(await recordViolation(kv, 'G1', 'U1'), 2);
  assert.equal(await getViolations(kv, 'G1', 'U1'), 2);
  await clearViolations(kv, 'G1', 'U1');
  assert.equal(await getViolations(kv, 'G1', 'U1'), 0);
});

/* ================= 存储层 ================= */
console.log('\n[存储层 repo]');
await t('CRUD 正常', async () => {
  const repo = createRepo(await createKV({}));
  const a = await repo.create('t', { name: 'A' });
  assert.ok(a.id && a.createdAt);
  const b = await repo.update('t', a.id, { name: 'B' });
  assert.equal(b.name, 'B');
  assert.equal(b.createdAt, a.createdAt);          // createdAt 不被覆盖
  assert.ok((await repo.get('t', a.id)).name === 'B');
  await repo.remove('t', a.id);
  assert.equal(await repo.get('t', a.id), null);
});
await t('更新不存在的记录返回 null', async () => {
  const repo = createRepo(await createKV({}));
  assert.equal(await repo.update('t', 'nope', { x: 1 }), null);
});
await t('主键不可被覆盖', async () => {
  const repo = createRepo(await createKV({}));
  const a = await repo.create('t', { name: 'A' });
  const b = await repo.update('t', a.id, { id: 'HACKED', name: 'B' });
  assert.equal(b.id, a.id);
});
await t('搜索 + 筛选', async () => {
  const repo = createRepo(await createKV({}));
  await repo.create('t', { name: '张三', status: 'active' });
  await repo.create('t', { name: '李四', status: 'muted' });
  const r = await repo.query('t', { search: '张', searchFields: ['name'], filters: { status: 'active' } });
  assert.equal(r.total, 1);
  assert.equal(r.items[0].name, '张三');
});
await t('排序 + 分页', async () => {
  const repo = createRepo(await createKV({}));
  for (let i = 1; i <= 5; i++) await repo.create('t', { name: `n${i}`, seq: i });
  const p1 = await repo.query('t', { sortKey: 'seq', sortDir: 'desc', page: 1, pageSize: 2 });
  assert.equal(p1.total, 5);
  assert.equal(p1.totalPages, 3);
  assert.deepEqual(p1.items.map((i) => i.seq), [5, 4]);
  const p3 = await repo.query('t', { sortKey: 'seq', sortDir: 'asc', page: 3, pageSize: 2 });
  assert.deepEqual(p3.items.map((i) => i.seq), [5]);
});

/* ================= 业务流水线 ================= */
console.log('\n[业务流水线 handlers]');
await t('ping', async () => {
  const r = await handleMessage(groupMsg('ping'), baseEnv);
  assert.match(r.content, /^pong/);
});
await t('帮助', async () => {
  const r = await handleMessage(groupMsg('帮助'), baseEnv);
  assert.match(r.content, /我可以做什么/);
});
await t('时间', async () => {
  const r = await handleMessage(groupMsg('时间'), baseEnv);
  assert.match(r.content, /^北京时间：\d{4}-\d{2}-\d{2}/);
});
await t('复读', async () => {
  const r = await handleMessage(groupMsg('复读 你好呀'), baseEnv);
  assert.equal(r.content, '你好呀');
});

console.log('\n[管理员指令（@目标提取 - 修复项）]');
await t('/禁言 @某人 10分钟 能正确识别目标', async () => {
  const e = groupMsg('/禁言 <@TARGET_OPENID> 10分钟', 'ADMIN1', 'G_ADMIN', 'M_A1');
  const r = await handleMessage(e, baseEnv);
  assert.ok(r && r.content, '应有回复');
  assert.match(r.content, /已禁言 10 分钟/, `实际: ${r.content}`);
});
await t('/解禁 @某人 能正确识别目标', async () => {
  const e = groupMsg('/解禁 <@TARGET_OPENID>', 'ADMIN1', 'G_ADMIN', 'M_A2');
  const r = await handleMessage(e, baseEnv);
  assert.match(r.content, /已解除禁言/, `实际: ${r.content}`);
});
await t('/违规分 @某人 能正确识别目标', async () => {
  const e = groupMsg('/违规分 <@TARGET_OPENID>', 'ADMIN1', 'G_ADMIN', 'M_A3');
  const r = await handleMessage(e, baseEnv);
  assert.match(r.content, /违规次数/, `实际: ${r.content}`);
});
await t('/踢 @某人 无内邀权限时优雅提示', async () => {
  const e = groupMsg('/踢 <@TARGET_OPENID>', 'ADMIN1', 'G_ADMIN', 'M_A4');
  const r = await handleMessage(e, baseEnv);
  assert.ok(r && r.content, '应有回复');
  assert.match(r.content, /移出群聊|踢人失败/, `实际: ${r.content}`);
});
await t('/广告关 生效', async () => {
  const e = groupMsg('/广告关', 'ADMIN1', 'G_ADMIN', 'M_A5');
  const r = await handleMessage(e, baseEnv);
  assert.match(r.content, /已关闭广告过滤/);
});
await t('非管理员不能执行管理指令', async () => {
  const e = groupMsg('/广告关', 'NOT_ADMIN', 'G_ADMIN', 'M_A6');
  const r = await handleMessage(e, baseEnv);
  // 非管理员发显式 / 指令：不进入管理分支，且收到明确的无权限反馈（不再静默落入 AI）
  assert.ok(r && r.content, '应有显式无权限回复');
  assert.match(r.content, /仅群管理员可用/, `实际: ${r.content}`);
  // 不带 / 的中文关键词不提示（避免误伤普通聊天，如「踢足球」）
  const e2 = groupMsg('踢足球去', 'NOT_ADMIN', 'G_ADMIN', 'M_A6b');
  const r2 = await handleMessage(e2, baseEnv);
  assert.equal(r2, null);
});

console.log('\n[AD_ACTION 分级（修复项）]');
await t('AD_ACTION=warn 时不撤回消息', async () => {
  const env = { ...baseEnv, AD_ACTION: 'warn' };
  const logs = await captureLogs(async () => {
    await handleMessage(groupMsg('加我vx: abcd1234', 'U9', 'G_ACT1', 'M_ACT1'), env);
  });
  assert.ok(!logs.some((l) => l.includes('[MOCK] DELETE')), `不应有撤回，实际: ${JSON.stringify(logs)}`);
});
await t('AD_ACTION=delete 时撤回但不禁言', async () => {
  const env = { ...baseEnv, AD_ACTION: 'delete' };
  let plan = null;
  const logs = await captureLogs(async () => {
    // 累计到阈值，验证 delete 级别下仍不禁言
    for (let i = 0; i < 3; i++) {
      plan = await handleMessage(groupMsg('加我vx: abcd1234', 'U9', 'G_ACT2', `M_ACT2_${i}`), env);
    }
  });
  // 撤回改为「先警告后撤回」：plan 携带 recallMsgId，由 core.js 回复成功后执行
  assert.ok(plan && plan.recallMsgId, '撤回计划应随 plan 返回（recallMsgId）');
  assert.ok(!logs.some((l) => l.includes('restrict_chat_setting')), `不应禁言，实际: ${logs}`);
});
await t('AD_ACTION=delete_mute 达阈值后禁言', async () => {
  const env = { ...baseEnv, AD_ACTION: 'delete_mute' };
  let plan = null;
  const logs = await captureLogs(async () => {
    for (let i = 0; i < 3; i++) {
      plan = await handleMessage(groupMsg('加我vx: abcd1234', 'U9', 'G_ACT3', `M_ACT3_${i}`), env);
    }
  });
  assert.ok(plan && plan.recallMsgId, '撤回计划应随 plan 返回（recallMsgId）');
  assert.ok(logs.some((l) => l.includes('restrict_chat_setting')), `应禁言，实际: ${logs}`);
});
await t('警告文案为纯文本（依赖被动回复自动 @ 违规者，不含 @ 标签）', async () => {
  const env = { ...baseEnv, AD_ACTION: 'delete' };
  const plan = await handleMessage(groupMsg('加我vx: abcd1234', 'U9', 'G_AT1', 'M_AT1'), env);
  assert.ok(plan && plan.content, '应有警告回复');
  assert.ok(plan.msgId, '应为被动回复（引用违规消息 msg_id，客户端自动 @ 违规者）');
  assert.doesNotMatch(plan.content, /<@|qqbot-at-user/, `不应含 @ 标签（平台不渲染只会原样显示），实际: ${plan.content}`);
  assert.match(plan.content, /违反群规/, `应包含违规提示，实际: ${plan.content}`);
});
await t('警告文案带 @昵称 前缀（author.username），不含规则名', async () => {
  const env = { ...baseEnv, AD_ACTION: 'delete' };
  const e = evt('GROUP_AT_MESSAGE_CREATE', {
    group_openid: 'G_NAME', id: 'M_N1', content: '加我vx: abcd1234',
    author: { member_openid: 'U_NAME', username: '小明' },
  });
  const plan = await handleMessage(e, env);
  assert.ok(plan && plan.content, '应有警告回复');
  assert.match(plan.content, /^@小明 /, `应以 @昵称 开头，实际: ${plan.content}`);
  assert.match(plan.content, /（第 1 次）/, `应含实际次数，实际: ${plan.content}`);
  assert.doesNotMatch(plan.content, /命中规则/, `不应暴露规则名，实际: ${plan.content}`);
});
await t('第 4 次违规：计划踢出并拉黑（kickAfterReply），文案为移出提示', async () => {
  const env = { ...baseEnv, AD_ACTION: 'delete_mute', AD_MUTE_THRESHOLD: '1', AD_KICK_THRESHOLD: '4' };
  let plan = null;
  for (let i = 0; i < 4; i++) {
    plan = await handleMessage(groupMsg('加我vx: abcd1234', 'U_KICK', 'G_KICK', `M_K_${i}`), env);
  }
  assert.ok(plan && plan.kickAfterReply, '第 4 次应携带 kickAfterReply');
  assert.deepEqual(plan.kickAfterReply.memberOpenids, ['U_KICK']);
  assert.equal(plan.kickAfterReply.addToBlacklist, true);
  assert.match(plan.content, /（第 4 次）/, `应含次数，实际: ${plan.content}`);
  assert.match(plan.content, /已被移出群聊并加入黑名单/, `应含移出提示，实际: ${plan.content}`);
  assert.doesNotMatch(plan.content, /禁言/, `踢出时不应再提禁言，实际: ${plan.content}`);
  // 本地黑名单已同步标记
  const again = await handleMessage(groupMsg('我还在群里', 'U_KICK', 'G_KICK', 'M_K_AFTER'), env);
  assert.equal(again, null, '被处置成员消息应被本地黑名单忽略');
});
await t('后台设置 adKickThreshold 优先于环境变量', async () => {
  const { saveSettings } = await import('../src/records.js');
  const kv = await createKV({});
  await saveSettings(kv, { adKickThreshold: 2 });
  try {
    const env = { ...baseEnv, AD_MUTE_THRESHOLD: '1' };
    let plan = null;
    for (let i = 0; i < 2; i++) {
      plan = await handleMessage(groupMsg('加我vx: abcd1234', 'U_KICK2', 'G_KICK2', `M_K2_${i}`), env);
    }
    assert.ok(plan && plan.kickAfterReply, '设置踢出阈值=2 时第 2 次应 kick');
  } finally {
    await saveSettings(kv, { adKickThreshold: '' }); // 还原，避免影响后续用例
  }
});
await t('/退群 指令：退群提示 + 拉黑', async () => {
  const e = groupMsg('/退群 <@LEAVER>', 'ADMIN1', 'G_LEAVE', 'M_L1');
  const r = await handleMessage(e, baseEnv);
  assert.ok(r && r.content, '应有退群提示');
  assert.doesNotMatch(r.content, /<@|qqbot-at-user/, `不应含 @ 标签，实际: ${r.content}`);
  assert.match(r.content, /黑名单/, `应提示已拉黑，实际: ${r.content}`);
  // 拉黑后该成员发言应被静默忽略
  const e2 = groupMsg('我回来了', 'LEAVER', 'G_LEAVE', 'M_L2');
  const r2 = await handleMessage(e2, baseEnv);
  assert.equal(r2, null, '黑名单成员发言应被忽略');
});

console.log('\n[正文清理]');
await t('清理 @ 段但保留邮箱等含 @ 的正常文本', () => {
  assert.equal(stripMentions('<@OPENID> 你好'), '你好');
  assert.equal(stripMentions('邮箱 a@b.com'), '邮箱 a@b.com');
});
await t('提取多个 @ 目标', () => {
  assert.deepEqual(extractMentions('<@A> 和 <@!B>'), ['A', 'B']);
});

console.log('\n[事件处理]');
await t('机器人被移出群：标记 inactive 不回复', async () => {
  const r = await handleMessage(evt('GROUP_DEL_ROBOT', { group_openid: 'G1' }), baseEnv);
  assert.equal(r, null);
});
await t('好友添加：c2c 引导语', async () => {
  const r = await handleMessage(evt('FRIEND_ADD', { user_openid: 'U3' }), baseEnv);
  assert.equal(r.chatType, 'c2c');
  assert.match(r.content, /帮助/);
});
await t('好友删除：静默', async () => {
  const r = await handleMessage(evt('FRIEND_DEL', { user_openid: 'U3' }), baseEnv);
  assert.equal(r, null);
});
await t('机器人进群欢迎', async () => {
  const r = await handleMessage(evt('GROUP_ADD_ROBOT', { group_openid: 'G1' }), baseEnv);
  assert.match(r.content, /大家好/);
});

/* ---------------- 成员加入 / 退出 ---------------- */
await t('新成员进群：发欢迎语 + 自动建档', async () => {
  const r = await handleMessage(evt('GROUP_MEMBER_ADD', {
    group_openid: 'G_W1', member_openid: 'M_NEW1',
  }), baseEnv);
  assert.ok(r && r.content, '应有欢迎语');
  assert.match(r.content, /欢迎/);
  const kv = await createKV(baseEnv);
  const member = await createRepo(kv).get(COLLECTIONS.MEMBERS, 'G_W1:M_NEW1');
  assert.ok(member, '成员应已建档');
  assert.equal(member.status, 'normal');
});
await t('后台自定义欢迎词全局生效', async () => {
  const kv = await createKV(baseEnv);
  await saveSettings(kv, { memberWelcome: '🎊 自定义欢迎词' });
  const r = await handleMessage(evt('GROUP_MEMBER_ADD', {
    group_openid: 'G_W2', member_openid: 'M_NEW2',
  }), baseEnv);
  assert.equal(r.content, '🎊 自定义欢迎词');
});
await t('群级欢迎词优先于全局设置', async () => {
  const kv = await createKV(baseEnv);
  await saveSettings(kv, { memberWelcome: '全局词' });
  await touchGroup(kv, 'G_W3', {});
  await touchGroup(kv, 'G_W3', { memberWelcome: '群专属词' });
  const r = await handleMessage(evt('GROUP_MEMBER_ADD', {
    group_openid: 'G_W3', member_openid: 'M_NEW3',
  }), baseEnv);
  assert.equal(r.content, '群专属词');
});
await t('迎宾总开关关闭后不发言', async () => {
  const kv = await createKV(baseEnv);
  await saveSettings(kv, { welcomeEnabled: false });
  const r = await handleMessage(evt('GROUP_MEMBER_ADD', {
    group_openid: 'G_W4', member_openid: 'M_NEW4',
  }), baseEnv);
  assert.equal(r, null);
});
await t('成员退群：提示 + 自动拉黑 + 后续消息忽略', async () => {
  const kv = await createKV(baseEnv);
  await touchMember(kv, 'G_L1', 'M_LEAVE', { status: 'normal' });
  const r = await handleMessage(evt('GROUP_MEMBER_REMOVE', {
    group_openid: 'G_L1', member_openid: 'M_LEAVE',
  }), baseEnv);
  assert.ok(r && r.content, '应有退群提示');
  const member = await createRepo(kv).get(COLLECTIONS.MEMBERS, 'G_L1:M_LEAVE');
  assert.equal(member.status, 'blacklisted');
  const after = await handleMessage(groupMsg('我回来了', 'M_LEAVE', 'G_L1', 'M_L_2'), baseEnv);
  assert.equal(after, null, '黑名单成员发言应被忽略');
});
await t('退群自动拉黑可关闭（只发提示）', async () => {
  const kv = await createKV(baseEnv);
  await saveSettings(kv, { autoBlacklistOnLeave: false });
  await touchMember(kv, 'G_L2', 'M_LEAVE2', { status: 'normal' });
  const r = await handleMessage(evt('GROUP_MEMBER_REMOVE', {
    group_openid: 'G_L2', member_openid: 'M_LEAVE2',
  }), baseEnv);
  assert.ok(r && r.content, '应有退群提示');
  const member = await createRepo(kv).get(COLLECTIONS.MEMBERS, 'G_L2:M_LEAVE2');
  assert.equal(member.status, 'normal', '不应被拉黑');
});
await t('黑名单成员重新入群：保留黑名单并提示管理员', async () => {
  const kv = await createKV(baseEnv);
  await touchMember(kv, 'G_R1', 'M_BACK', { status: 'blacklisted' });
  const r = await handleMessage(evt('GROUP_MEMBER_ADD', {
    group_openid: 'G_R1', member_openid: 'M_BACK',
  }), baseEnv);
  assert.match(r.content, /黑名单/);
  const member = await createRepo(kv).get(COLLECTIONS.MEMBERS, 'G_R1:M_BACK');
  assert.equal(member.status, 'blacklisted', '黑名单状态不应被重置');
});

/* ---------------- 入群申请 GROUP_JOIN_REQUEST ---------------- */
console.log('\n[入群申请]');
await t('入群申请：默认发群内通知 + 落库 pending', async () => {
  const r = await handleMessage(evt('GROUP_JOIN_REQUEST', {
    group_openid: 'G_J1', member_openid: 'M_J1', username: '小明',
    join_request_id: 'JR_1', apply_source: 'self_apply',
    apply_at: '2026-10-23T14:00:00+08:00',
  }), baseEnv);
  assert.ok(r && r.content, '应有群通知');
  assert.match(r.content, /小明/);
  assert.match(r.content, /主动申请/);
  const kv = await createKV(baseEnv);
  const rec = await createRepo(kv).get(COLLECTIONS.JOIN_REQUESTS, 'G_J1:M_J1');
  assert.equal(rec.status, 'pending');
  assert.equal(rec.joinRequestId, 'JR_1');
});
await t('入群申请：黑名单申请人自动拒绝 + 状态落库 + 日志', async () => {
  const kv = await createKV(baseEnv);
  await touchMember(kv, 'G_J2', 'M_BLK', { status: 'blacklisted' });
  const r = await handleMessage(evt('GROUP_JOIN_REQUEST', {
    group_openid: 'G_J2', member_openid: 'M_BLK', username: '坏账号',
    join_request_id: 'JR_2',
  }), baseEnv);
  assert.equal(r, null, '自动拒绝应静默，不在群里刷屏');
  const rec = await createRepo(kv).get(COLLECTIONS.JOIN_REQUESTS, 'G_J2:M_BLK');
  assert.equal(rec.status, 'declined');
  assert.equal(rec.handledBy, 'auto:blacklist');
  const logs = await createRepo(kv).list(COLLECTIONS.LOGS);
  assert.ok(logs.some((x) => x.action === 'join_declined'), '应记录 join_declined');
});
await t('入群申请：自动通过开关生效', async () => {
  const kv = await createKV(baseEnv);
  await saveSettings(kv, { joinAutoApprove: true });
  const r = await handleMessage(evt('GROUP_JOIN_REQUEST', {
    group_openid: 'G_J3', member_openid: 'M_OK', username: '正常用户', join_request_id: 'JR_3',
  }), baseEnv);
  assert.equal(r, null, '自动通过不再发群通知');
  const rec = await createRepo(kv).get(COLLECTIONS.JOIN_REQUESTS, 'G_J3:M_OK');
  assert.equal(rec.status, 'approved');
  const member = await createRepo(kv).get(COLLECTIONS.MEMBERS, 'G_J3:M_OK');
  assert.equal(member.status, 'normal');
});
await t('入群申请：有风险提示则不自动通过，改走通知', async () => {
  const kv = await createKV(baseEnv);
  await saveSettings(kv, { joinAutoApprove: true });
  const r = await handleMessage(evt('GROUP_JOIN_REQUEST', {
    group_openid: 'G_J4', member_openid: 'M_RISK', username: '风险号',
    risk_tips: 'warning_tips', join_request_id: 'JR_4',
  }), baseEnv);
  assert.ok(r && r.content);
  assert.match(r.content, /风险/);
});
await t('入群申请：总开关关闭后完全忽略', async () => {
  const kv = await createKV(baseEnv);
  await saveSettings(kv, { joinRequestEnabled: false });
  const r = await handleMessage(evt('GROUP_JOIN_REQUEST', {
    group_openid: 'G_J5', member_openid: 'M_J5',
  }), baseEnv);
  assert.equal(r, null);
});
await t('入群申请：群级通知文案 + 占位符替换', async () => {
  const kv = await createKV(baseEnv);
  await touchGroup(kv, 'G_J6', {});
  await touchGroup(kv, 'G_J6', { joinNotice: '【{name}】想进群（{source}）' });
  const r = await handleMessage(evt('GROUP_JOIN_REQUEST', {
    group_openid: 'G_J6', member_openid: 'M_J6', username: '阿强', apply_source: 'invited',
  }), baseEnv);
  assert.equal(r.content, '【阿强】想进群（被邀请）');
});
await t('后台审批：通过后状态变 approved 且成员恢复正常', async () => {
  const token = await signSession({ username: 'admin', role: 'owner' }, 'sess-secret', 3600);
  const env = { ...baseEnv, ADMIN_SESSION_SECRET: 'sess-secret' };
  const kv = await createKV(env);
  await saveJoinRequest(kv, {
    groupOpenid: 'G_J7', memberOpenid: 'M_J7', username: '待审批', joinRequestId: 'JR_7',
  });
  const res = await joinrequestsHandler({
    request: new Request('https://x/api/admin/joinrequests', {
      method: 'POST',
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ id: 'G_J7:M_J7', op: 'approve' }),
    }),
    env,
  });
  const j = await res.json();
  assert.equal(j.ok, true, JSON.stringify(j));
  assert.equal(j.item.status, 'approved');
  const member = await createRepo(kv).get(COLLECTIONS.MEMBERS, 'G_J7:M_J7');
  assert.equal(member.status, 'normal');
});

/* ---------------- 设置接口 ---------------- */
console.log('\n[欢迎词设置接口]');
await t('settings 未登录 → 401', async () => {
  const res = await settingsHandler({ request: new Request('https://x/api/admin/settings'), env: baseEnv });
  assert.equal(res.status, 401);
});
await t('settings PUT 保存并读回（仅白名单字段）', async () => {
  const token = await signSession({ username: 'admin', role: 'owner' }, 'sess-secret', 3600);
  const env = { ...baseEnv, ADMIN_SESSION_SECRET: 'sess-secret' };
  const put = await settingsHandler({
    request: new Request('https://x/api/admin/settings', {
      method: 'PUT', headers: { cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ memberWelcome: '后台自定义', evil: 'x' }),
    }),
    env,
  });
  const pj = await put.json();
  assert.equal(pj.ok, true);
  const get = await settingsHandler({
    request: new Request('https://x/api/admin/settings', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
    env,
  });
  const gj = await get.json();
  assert.equal(gj.item.memberWelcome, '后台自定义');
  assert.equal(gj.item.evil, undefined, '非白名单字段不应写入');
  assert.equal(gj.item.welcomeEnabled, true, '缺省值为开启');
  assert.equal(gj.item.joinRequestEnabled, true, '入群申请处理缺省开启');
  assert.equal(gj.item.joinAutoApprove, false, '自动通过缺省关闭');
  assert.equal(gj.item.joinAutoRejectBlacklist, true, '黑名单自动拒绝缺省开启');
});
await t('settings PUT 违规处置数值字段（数字类型 + effective 展示）', async () => {
  const token = await signSession({ username: 'admin', role: 'owner' }, 'sess-secret', 3600);
  const env = { ...baseEnv, ADMIN_SESSION_SECRET: 'sess-secret' };
  const put = await settingsHandler({
    request: new Request('https://x/api/admin/settings', {
      method: 'PUT', headers: { cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ adMuteThreshold: '1', adKickThreshold: '4', adAction: 'delete_mute' }),
    }),
    env,
  });
  const pj = await put.json();
  assert.equal(pj.ok, true, `应保存成功: ${JSON.stringify(pj)}`);
  assert.equal(pj.item.adMuteThreshold, 1, '数值字段应存为数字');
  assert.equal(pj.item.adKickThreshold, 4, '数值字段应存为数字');
  assert.equal(pj.item.adAction, 'delete_mute');
  const bad = await settingsHandler({
    request: new Request('https://x/api/admin/settings', {
      method: 'PUT', headers: { cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ adKickThreshold: 'abc' }),
    }),
    env,
  });
  assert.notEqual(bad.status, 200, '非法数字应拒绝');
  const get = await settingsHandler({
    request: new Request('https://x/api/admin/settings', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
    env,
  });
  const gdata = await get.json();
  assert.ok(gdata.effective && 'adKickThreshold' in gdata.effective, 'GET 应返回 effective 生效值');
  // 还原为空（回退环境变量），避免影响其他用例
  await settingsHandler({
    request: new Request('https://x/api/admin/settings', {
      method: 'PUT', headers: { cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ adMuteThreshold: '', adKickThreshold: '', adAction: '' }),
    }),
    env,
  });
});

/* ================= 入口 core ================= */
console.log('\n[入口 core]');
await t('GET /health 返回 200', async () => {
  const res = await handleRequest(new Request('https://x/api/qq/health'), baseEnv, {});
  assert.equal(res.status, 200);
});
await t('非 POST 返回 405', async () => {
  const res = await handleRequest(new Request('https://x/api/qq/webhook', { method: 'PUT' }), baseEnv, {});
  assert.equal(res.status, 405);
});
await t('无签名返回 401', async () => {
  const res = await handleRequest(new Request('https://x/api/qq/webhook', {
    method: 'POST', body: '{"op":0}',
  }), baseEnv, {});
  assert.equal(res.status, 401);
});
await t('op=13 回调验证：官方格式（无签名头→返回 plain_token+hex 签名）', async () => {
  const body = JSON.stringify({ op: 13, d: { plain_token: 'Arq0D5A61EgUu4OxUvOp', event_ts: '1725442341' } });
  // 官方规定校验请求不带签名头
  const res = await handleRequest(new Request('https://x/api/qq/webhook', {
    method: 'POST',
    body,
  }), { ...baseEnv, CALLBACK_PUBLIC_KEY: await loadPublicKeyFor() }, { waitUntil: () => {} });
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.equal(out.plain_token, 'Arq0D5A61EgUu4OxUvOp');
  assert.match(out.signature, /^[0-9a-f]{128}$/); // hex 64 字节
  // 应答签名可由 APP_SECRET 派生公钥验证
  const pub = derivePublicKey(baseEnv.APP_SECRET);
  const msg = Buffer.from('1725442341' + 'Arq0D5A61EgUu4OxUvOp', 'utf8');
  assert.equal(ncrypto.verify(null, msg, pub, Buffer.from(out.signature, 'hex')), true);
});
await t('op=13 校验：与 APP_SECRET 派生公钥闭环（无 CALLBACK_PUBLIC_KEY）', async () => {
  const body = JSON.stringify({ op: 13, d: { plain_token: 'tok', event_ts: '99' } });
  const env = { ...baseEnv };
  delete env.APP_SECRET;
  env.APP_SECRET = 'another-secret';
  const res = await handleRequest(new Request('https://x/api/qq/webhook', { method: 'POST', body }), env, {});
  assert.equal(res.status, 200);
  const out = await res.json();
  const pub = derivePublicKey('another-secret');
  assert.equal(ncrypto.verify(null, Buffer.from('99tok', 'utf8'), pub, Buffer.from(out.signature, 'hex')), true);
});
await t('op=13 校验：缺 plain_token 返回 400', async () => {
  const body = JSON.stringify({ op: 13, d: { event_ts: '1' } });
  const res = await handleRequest(new Request('https://x/api/qq/webhook', { method: 'POST', body }), baseEnv, {});
  assert.equal(res.status, 400);
});

/* 辅助：导出 base64 原始公钥 */
async function loadPublicKeyFor() {
  return b64(kp.publicKey.export({ format: 'der', type: 'spki' }).slice(-32));
}

console.log('\n[AI 对话与成本护栏]');
const stubAI = () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response(
    JSON.stringify({ choices: [{ message: { content: 'AI 回答' } }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
  return () => { globalThis.fetch = orig; };
};

await t('AI 正常回复并记住上下文', async () => {
  const restore = stubAI();
  try {
    const env = { ...baseEnv, AI_ENABLED: 'true', AI_API_KEY: 'k' };
    const r1 = await handleMessage(groupMsg('你好', 'U1', 'G_AI_1', 'M_AI_1'), env);
    assert.equal(r1.content, 'AI 回答');
    const r2 = await handleMessage(groupMsg('再说一次', 'U1', 'G_AI_1', 'M_AI_2'), env);
    assert.equal(r2.content, 'AI 回答');
  } finally { restore(); }
});

await t('后台关闭 AI 对话总开关后不回复，广告拦截与管理指令仍生效', async () => {
  const restore = stubAI();
  const kv = await createKV({});
  try {
    await saveSettings(kv, { aiChatEnabled: false });
    const env = { ...baseEnv, AI_ENABLED: 'true', AI_API_KEY: 'k' };
    const r = await handleMessage(groupMsg('你好呀', 'U_AIOFF', 'G_AIOFF', 'M_AIOFF_1'), env);
    assert.equal(r, null, '总开关关闭时普通消息不应触发 AI 回复');
    const ad = await handleMessage(groupMsg('加我vx: abcd1234', 'U_AIOFF', 'G_AIOFF', 'M_AIOFF_2'), env);
    assert.ok(ad && /违反群规/.test(ad.content), `广告拦截应照常生效，实际: ${ad && ad.content}`);
  } finally {
    await saveSettings(kv, { aiChatEnabled: true }); // 还原，避免影响其他用例
    restore();
  }
});

await t('每分钟频控拦截第 3 次', async () => {
  const restore = stubAI();
  try {
    const env = {
      ...baseEnv, AI_ENABLED: 'true', AI_API_KEY: 'k', AI_RATE_LIMIT_PER_MIN: '2',
    };
    await handleMessage(groupMsg('a', 'U1', 'G_RL', 'M1'), env);
    await handleMessage(groupMsg('b', 'U1', 'G_RL', 'M2'), env);
    const r = await handleMessage(groupMsg('c', 'U1', 'G_RL', 'M3'), env);
    assert.match(r.content, /太频繁/);
  } finally { restore(); }
});

await t('每日预算上限拦截', async () => {
  const restore = stubAI();
  try {
    const env = {
      ...baseEnv, AI_ENABLED: 'true', AI_API_KEY: 'k',
      AI_DAILY_LIMIT: '1', AI_RATE_LIMIT_PER_MIN: '100',
    };
    await handleMessage(groupMsg('a', 'U1', 'G_BUD', 'M1'), env);
    const r = await handleMessage(groupMsg('b', 'U1', 'G_BUD', 'M2'), env);
    assert.match(r.content, /今日 AI 调用已用完/);
  } finally { restore(); }
});

console.log('\n[AI 连通性测试端点]');
await t('aitest 未登录 → 401', async () => {
  const res = await aitestHandler({
    request: new Request('https://x/api/admin/aitest', { method: 'POST' }),
    env: baseEnv,
  });
  assert.equal(res.status, 401);
});
await t('aitest 未配置 AI_API_KEY', async () => {
  const token = await signSession({ username: 'admin', role: 'owner' }, 'sess-secret', 3600);
  const res = await aitestHandler({
    request: new Request('https://x/api/admin/aitest', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${token}` },
    }),
    env: { ...baseEnv, ADMIN_SESSION_SECRET: 'sess-secret' },
  });
  const j = await res.json();
  assert.equal(j.ok, false);
  assert.equal(j.reason, 'not_configured');
});
await t('aitest mock 全通（回复 + 模型 + 延迟）', async () => {
  const token = await signSession({ username: 'admin', role: 'owner' }, 'sess-secret', 3600);
  const env = {
    ...baseEnv, ADMIN_SESSION_SECRET: 'sess-secret',
    AI_API_KEY: 'k', AI_MODEL: 'test-model',
  };
  const restore = stubAI();
  try {
    const res = await aitestHandler({
      request: new Request('https://x/api/admin/aitest', {
        method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${token}` },
      }),
      env,
    });
    const j = await res.json();
    assert.equal(j.ok, true);
    assert.equal(j.model, 'test-model');
    assert.equal(j.reply, 'AI 回答');
    assert.equal(typeof j.latencyMs, 'number');
  } finally { restore(); }
});

/* ---------------- msgtest ---------------- */
await t('候选 APP_ID 验证：token 成功', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ access_token: 'T', expires_in: 7200 }), { status: 200 });
  const r = await verifyAppIdCandidate('123', { APP_SECRET: 's' }, fakeFetch);
  assert.equal(r.ok, true);
  assert.equal(r.error, null);
});
await t('候选 APP_ID 验证：appid invalid', async () => {
  const fakeFetch = async () => new Response(JSON.stringify({ code: 100007, message: 'appid invalid' }), { status: 200 });
  const r = await verifyAppIdCandidate('123', { APP_SECRET: 's' }, fakeFetch);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'appid invalid');
});
await t('msgtest 未登录 401', async () => {
  const res = await msgtestHandler({
    request: new Request('https://x/api/admin/msgtest', { method: 'POST' }),
    env: { ...baseEnv, ADMIN_SESSION_SECRET: 'sess-secret' },
  });
  assert.equal(res.status, 401);
});
await t('msgtest 缺 targetId 400', async () => {
  const token = await signSession({ username: 'admin', role: 'owner' }, 'sess-secret', 3600);
  const res = await msgtestHandler({
    request: new Request('https://x/api/admin/msgtest', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({}),
    }),
    env: { ...baseEnv, ADMIN_SESSION_SECRET: 'sess-secret' },
  });
  assert.equal(res.status, 400);
});
await t('msgtest MOCK 模式明确报错', async () => {
  const token = await signSession({ username: 'admin', role: 'owner' }, 'sess-secret', 3600);
  const res = await msgtestHandler({
    request: new Request('https://x/api/admin/msgtest', {
      method: 'POST', headers: { cookie: `${SESSION_COOKIE}=${token}` },
      body: JSON.stringify({ targetId: 'G1' }),
    }),
    env: { ...baseEnv, ADMIN_SESSION_SECRET: 'sess-secret', MOCK: '1' },
  });
  const j = await res.json();
  assert.equal(res.status, 400);
  assert.match(j.error, /MOCK/);
});

/* ================= 汇总 ================= */
console.log('\n' + lines.join('\n'));
console.log(`\n自测结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
