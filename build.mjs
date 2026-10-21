/**
 * 构建脚本（零依赖）
 *  1. 校验部署所需目录结构
 *  2. 跑一遍自测作为构建门禁
 *  3. 生成 dist/ 部署目录（排除 node_modules / .git / 测试脚手架）
 * 用法： npm run build
 */
import {
  existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = resolve('.');
const DIST = join(ROOT, 'dist');

/** 部署必需文件 */
const REQUIRED = [
  'package.json',
  'dev-server.mjs',
  'admin/index.html',
  'functions/api/qq/webhook.js',
  'functions/api/qq/health.js',
  'functions/api/admin/login.js',
  'functions/api/admin/logout.js',
  'functions/api/admin/me.js',
  'functions/api/admin/overview.js',
  'functions/api/admin/groups.js',
  'functions/api/admin/members.js',
  'functions/api/admin/violations.js',
  'functions/api/admin/rules.js',
  'functions/api/admin/admins.js',
  'functions/api/admin/logs.js',
  'src/core.js',
  'src/handlers.js',
  'src/verify.js',
  'src/config.js',
  'src/adfilter.js',
  'src/moderation.js',
  'src/qqapi.js',
  'src/ai.js',
  'src/kv.js',
  'src/repo.js',
  'src/records.js',
  'src/store.js',
  'src/admin/auth.js',
  'src/admin/api.js',
  'src/admin/crud.js',
];

/** 不进部署产物 */
const SKIP = new Set([
  'node_modules', '.git', '.workbuddy', 'dist', 'build', 'probe', 'test', '.env',
]);

/** 递归复制目录 */
function copyDir(from, to) {
  mkdirSync(to, { recursive: true });
  for (const name of readdirSync(from)) {
    if (SKIP.has(name)) continue;
    const src = join(from, name);
    const dst = join(to, name);
    if (statSync(src).isDirectory()) copyDir(src, dst);
    else writeFileSync(dst, readFileSync(src));
  }
}

function bail(msg) {
  console.error('\n构建失败: ' + msg);
  process.exit(1);
}

console.log('=== 1. 校验部署结构 ===');
REQUIRED.forEach((p) => {
  const ok = existsSync(join(ROOT, p));
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + p);
  if (!ok) bail('缺少 ' + p);
});

console.log('\n=== 2. 运行自测（构建门禁）===');
let testLine = '';
try {
  const out = execFileSync(process.execPath, [join(ROOT, 'test', 'selftest.mjs')], { encoding: 'utf8' });
  testLine = (out.split('\n').filter((l) => l.includes('自测结果')).pop() || '').trim();
  console.log('  ' + testLine);
} catch (e) {
  bail('自测未通过: ' + (e.message || e));
}
if (/([1-9]\d*) 失败/.test(testLine)) bail('存在失败用例');

console.log('\n=== 3. 生成 dist/ 部署目录 ===');
// 幂等覆盖写入：不整目录删除，避免受限于运行环境的删除保护
mkdirSync(DIST, { recursive: true });

const ENTRIES = [
  'functions', 'src', 'admin', 'docs',
  'package.json', 'dev-server.mjs', 'README.md', '.env',
];

let entries = 0;
ENTRIES.forEach((name) => {
  const src = join(ROOT, name);
  if (!existsSync(src)) return;
  const dst = join(DIST, name);
  if (statSync(src).isDirectory()) copyDir(src, dst);
  else writeFileSync(dst, readFileSync(src));
  entries += 1;
});

console.log('  目录: dist/');
console.log('  条目: ' + entries);
console.log('\n构建完成');
