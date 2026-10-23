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
  'admin/login.html',
  'cloud-functions/api/qq/webhook.js',
  'cloud-functions/api/qq/health.js',
  'cloud-functions/api/admin/login.js',
  'cloud-functions/api/admin/logout.js',
  'cloud-functions/api/admin/me.js',
  'cloud-functions/api/admin/overview.js',
  'cloud-functions/api/admin/groups.js',
  'cloud-functions/api/admin/members.js',
  'cloud-functions/api/admin/violations.js',
  'cloud-functions/api/admin/rules.js',
  'cloud-functions/api/admin/admins.js',
  'cloud-functions/api/admin/logs.js',
  'cloud-functions/api/admin/settings.js',
  'cloud-functions/api/admin/joinrequests.js',
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

/**
 * Node Functions 构建只打包 cloud-functions/ 目录，
 * 跨目录引用需内联：复制 src/ 进 cloud-functions/src/ 并改写相对导入
 * （../../../src/x -> ../../src/x，因 src 现位于 cloud-functions/src）
 */
function rewriteImports(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) { rewriteImports(p); continue; }
    if (!p.endsWith('.js') && !p.endsWith('.mjs')) continue;
    const code = readFileSync(p, 'utf8');
    const next = code
      .split("'../../../src/").join("'../../src/")
      .split('"../../../src/').join('"../../src/');
    if (next !== code) writeFileSync(p, next);
  }
}

console.log('\n=== 3. 生成 dist/ 部署目录 ===');
// 幂等覆盖写入：不整目录删除，避免受限于运行环境的删除保护
mkdirSync(DIST, { recursive: true });

// .env 仅用于本地 dev-server，绝不进部署产物：
// 产物含 MOCK=1 会使机器人假运行，含口令则等于泄露
const ENTRIES = [
  'cloud-functions', 'src', 'admin', 'docs',
  'package.json', 'dev-server.mjs', 'README.md',
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

// 部署产物内没有 build.mjs 与 test/，若保留这些脚本，
// 平台构建阶段执行 npm run build 会因文件缺失而失败
const pkgPath = join(DIST, 'package.json');
if (existsSync(pkgPath)) {
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  pkg.scripts = { start: 'node dev-server.mjs' };
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log('  已精简 dist/package.json（scripts 仅保留 start）');
}

// Node Functions（cloud-functions/）运行于 Node 20，node:crypto 原生支持 Ed25519，
// 边缘 V8 的 WebCrypto 不支持（实测 importKey 抛 Param Invalid），故整体迁移
const CF_DIR = join(DIST, 'cloud-functions');
if (existsSync(CF_DIR) && existsSync(join(ROOT, 'src'))) {
  copyDir(join(ROOT, 'src'), join(CF_DIR, 'src'));
  rewriteImports(CF_DIR);
  console.log('  已内联 src/ -> cloud-functions/src/ 并改写导入路径');
}

// 线上是「静态站 + Node Functions」模式，dev-server 的 / 跳转不生效，
// 生成静态入口页把根路径导到管理后台
writeFileSync(
  join(DIST, 'index.html'),
  '<!doctype html><meta charset="utf-8"><title>QQ Bot Admin</title>'
    + '<script>location.replace("/admin/login.html")</script>',
);
console.log('  已生成 dist/index.html（根路径跳转后台）');

console.log('  目录: dist/');
console.log('  条目: ' + entries);
console.log('\n构建完成');
