/**
 * 端到端联调：真实 Ed25519 签名 -> handleRequest -> 业务处理 -> 模拟 QQ API 调用
 * 用法： node probe/e2e.mjs
 */
import { handleRequest } from '../src/core.js';

const crypto = globalThis.crypto;
const enc = new TextEncoder();
const b64 = (bytes) => {
  const arr = new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s);
};

const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
const pubB64 = b64(new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey)));

const env = {
  APP_ID: 'test-app',
  APP_SECRET: 'test-secret',
  CALLBACK_PUBLIC_KEY: pubB64,
  MOCK: 'true',
  AI_ENABLED: 'false',
  ADMIN_OPENIDS: 'ADMIN1',
};

async function post(bodyObj) {
  const body = JSON.stringify(bodyObj);
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = b64(await crypto.subtle.sign({ name: 'Ed25519' }, kp.privateKey, enc.encode(ts + body)));
  const request = new Request('https://x/api/qq/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-signature-ed25519': sig,
      'x-signature-timestamp': ts,
    },
    body,
  });
  const waited = [];
  const ctx = { waitUntil: (p) => waited.push(p) };
  const res = await handleRequest(request, env, ctx);
  await Promise.allSettled(waited);
  return res;
}

const evt = (t, d) => ({ op: 0, t, d });
let fails = 0;
const check = (name, cond, extra = '') => {
  if (cond) { console.log(`  PASS  ${name}`); } else { fails += 1; console.log(`  FAIL  ${name} ${extra}`); }
};

console.log('=== 1. 健康检查 ===');
{
  const res = await handleRequest(new Request('https://x/api/qq/health'), env, {});
  const j = await res.json();
  check('health 200', res.status === 200);
  check('health 返回服务名', j.service === 'qq-bot-edgeone', JSON.stringify(j));
}

console.log('\n=== 2. Webhook 校验（op=13 官方流程）===');
{
  // 官方规定：校验请求不带签名头，body 为 plain_token + event_ts，
  // 机器人须返回 {"plain_token","signature"(hex)}，签名可由 APP_SECRET 派生公钥验证
  const plainToken = 'Arq0D5A61EgUu4OxUvOp';
  const eventTs = String(Math.floor(Date.now() / 1000));
  const request = new Request('https://x/api/qq/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: 13, d: { plain_token: plainToken, event_ts: eventTs } }),
  });
  const res = await handleRequest(request, env, {});
  const j = await res.json();
  check('校验应答 200', res.status === 200, JSON.stringify(j));
  check('回传 plain_token', j.plain_token === plainToken, JSON.stringify(j));
  check('signature 为 hex(128)', typeof j.signature === 'string' && /^[0-9a-f]{128}$/.test(j.signature), JSON.stringify(j));
  if (j.signature) {
    // 用 APP_SECRET 派生公钥验证应答签名
    const { derivePublicKey } = await import('../src/verify.js');
    const pub = derivePublicKey(env.APP_SECRET);
    const ncrypto = (await import('node:crypto')).default;
    const msg = Buffer.from(eventTs + plainToken, 'utf8');
    check('应答签名可由派生公钥验证', ncrypto.verify(null, msg, pub, Buffer.from(j.signature, 'hex')));
  }
}

console.log('\n=== 3. 群消息 -> 基础指令 ===');
{
  const res = await post(evt('GROUP_AT_MESSAGE_CREATE', {
    group_openid: 'G_E2E', id: 'M1', content: 'ping', author: { user_openid: 'U1' },
  }));
  check('ping 请求受理 200', res.status === 200);
}

console.log('\n=== 4. 管理员指令（@目标提取 - 修复项）===');
{
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  const res = await post(evt('GROUP_AT_MESSAGE_CREATE', {
    group_openid: 'G_E2E', id: 'M2',
    content: '/禁言 <@REAL_TARGET_OPENID> 30分钟',
    author: { user_openid: 'ADMIN1' },
  }));
  console.log = origLog;
  check('受理 200', res.status === 200);
  const muteLog = logs.find((l) => l.includes('restrict_chat_setting'));
  check('已发起禁言请求', !!muteLog, JSON.stringify(logs));
  check('禁言目标为被 @ 的用户', !!muteLog && muteLog.includes('REAL_TARGET_OPENID'), muteLog);
}

console.log('\n=== 5. 广告违规 -> 撤回 + 落库 ===');
{
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { logs.push(a.map(String).join(' ')); };
  for (let i = 0; i < 3; i++) {
    await post(evt('GROUP_AT_MESSAGE_CREATE', {
      group_openid: 'G_E2E_AD', id: `AD_M${i}`,
      content: '加我vx: abcd1234', author: { user_openid: 'U_SPAM' },
    }));
  }
  console.log = origLog;
  check('触发撤回', logs.some((l) => l.includes('[MOCK] DELETE')), JSON.stringify(logs));
  check('触发阶梯禁言', logs.some((l) => l.includes('restrict_chat_setting')), JSON.stringify(logs));
}

console.log('\n=== 6. 未签名请求被拒 ===');
{
  const request = new Request('https://x/api/qq/webhook', { method: 'POST', body: '{"op":0}' });
  const res = await handleRequest(request, env, {});
  check('401 拒绝', res.status === 401);
}

console.log(`\n端到端结果：${fails === 0 ? '全部通过' : fails + ' 项失败'}`);
process.exit(fails === 0 ? 0 : 1);
