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
await t('达阈值后阶梯禁言', () => {
  assert.equal(decideAction(3, cfgEmpty).muteSeconds, 600);
  assert.equal(decideAction(4, cfgEmpty).muteSeconds, 1200);
});
await t('封顶生效', () => {
  assert.equal(decideAction(20, cfgEmpty).muteSeconds, cfgEmpty.AD_MUTE_MAX_SECONDS);
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
  // 非管理员不进入管理分支，且不以 / 开头走 AI（此处 AI 关闭）-> 无回复
  assert.equal(r, null);
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
  const logs = await captureLogs(async () => {
    // 累计到阈值，验证 delete 级别下仍不禁言
    for (let i = 0; i < 3; i++) {
      await handleMessage(groupMsg('加我vx: abcd1234', 'U9', 'G_ACT2', `M_ACT2_${i}`), env);
    }
  });
  assert.ok(logs.some((l) => l.includes('[MOCK] DELETE')), '应有撤回');
  assert.ok(!logs.some((l) => l.includes('restrict_chat_setting')), `不应禁言，实际: ${logs}`);
});
await t('AD_ACTION=delete_mute 达阈值后禁言', async () => {
  const env = { ...baseEnv, AD_ACTION: 'delete_mute' };
  const logs = await captureLogs(async () => {
    for (let i = 0; i < 3; i++) {
      await handleMessage(groupMsg('加我vx: abcd1234', 'U9', 'G_ACT3', `M_ACT3_${i}`), env);
    }
  });
  assert.ok(logs.some((l) => l.includes('[MOCK] DELETE')), '应有撤回');
  assert.ok(logs.some((l) => l.includes('restrict_chat_setting')), `应禁言，实际: ${logs}`);
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

/* ================= 汇总 ================= */
console.log('\n' + lines.join('\n'));
console.log(`\n自测结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
