/**
 * 从 APP_SECRET 派生 QQ Webhook 回调验签公钥（官方算法）
 *
 * 出处：QQ 开放平台官方文档「安全和授权」
 *   https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/sign.html
 * 算法（官方 Go 示例的等价实现）：
 *   seed := botSecret
 *   for len(seed) < ed25519.SeedSize { seed = strings.Repeat(seed, 2) }
 *   seed = seed[:32]  → 以此为 Ed25519 seed 生成密钥对
 *
 * 用法： node tools/derive-callback-key.mjs <APP_SECRET>
 * 输出的 base64 即 CALLBACK_PUBLIC_KEY 环境变量的值
 *
 * 注：运行时（src/core.js）会自动由 APP_SECRET 派生同一把公钥，
 * CALLBACK_PUBLIC_KEY 已改为可选配置；本工具仅用于人工核对/排查。
 */
import crypto from 'node:crypto';

const secret = process.argv[2] || process.env.APP_SECRET;
if (!secret) {
  console.error('用法: node tools/derive-callback-key.mjs <APP_SECRET>');
  process.exit(1);
}

// 官方算法：不足 32 字节则自我翻倍，再截取前 32 字节
let seed = String(secret);
while (Buffer.byteLength(seed) < 32) seed += seed;
const seedBuf = Buffer.from(seed, 'utf8').subarray(0, 32);

// PKCS#8 DER 包装（Ed25519 固定前缀 + 32 字节 seed）
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const pkcs8 = Buffer.concat([PKCS8_PREFIX, seedBuf]);

const privateKey = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
const publicKey = crypto.createPublicKey(privateKey);

// SPKI DER 的最后 32 字节即原始公钥
const spki = publicKey.export({ format: 'der', type: 'spki' });
const rawPub = spki.subarray(spki.length - 32);

console.log(rawPub.toString('base64'));
