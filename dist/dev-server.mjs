/**
 * 开发 / 部署服务器（零依赖）
 *   :8788  ->  按 functions/ 目录结构转发到对应函数；仅 /admin/* 提供静态资源
 *
 * 部署契约：必须监听 PORT 环境变量，并绑定 0.0.0.0
 * 用法： npm run dev   /   npm start
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';

const PORT = Number(process.env.PORT) || 8788;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = resolve('.');
const STATIC_ROOT = join(ROOT, 'admin');

/** 极简 .env 解析（KEY=VALUE，忽略 # 注释） */
function loadDotEnv(text) {
  const out = {};
  text.split(/\r?\n/).forEach((line) => {
    const s = line.trim();
    if (!s || s.startsWith('#')) return;
    const i = s.indexOf('=');
    if (i < 0) return;
    const k = s.slice(0, i).trim();
    let v = s.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (k) out[k] = v;
  });
  return out;
}

let env = { ...process.env };
try {
  env = { ...env, ...loadDotEnv(await readFile(join(ROOT, '.env'), 'utf8')) };
} catch { /* 无 .env 时忽略 */ }

/** 路由表：URL 路径 -> 函数模块 */
const ROUTES = new Map([
  ['/api/qq/health', () => import('./functions/api/qq/health.js')],
  ['/api/qq/webhook', () => import('./functions/api/qq/webhook.js')],
  ['/api/admin/login', () => import('./functions/api/admin/login.js')],
  ['/api/admin/logout', () => import('./functions/api/admin/logout.js')],
  ['/api/admin/me', () => import('./functions/api/admin/me.js')],
  ['/api/admin/overview', () => import('./functions/api/admin/overview.js')],
  ['/api/admin/groups', () => import('./functions/api/admin/groups.js')],
  ['/api/admin/members', () => import('./functions/api/admin/members.js')],
  ['/api/admin/violations', () => import('./functions/api/admin/violations.js')],
  ['/api/admin/rules', () => import('./functions/api/admin/rules.js')],
  ['/api/admin/admins', () => import('./functions/api/admin/admins.js')],
  ['/api/admin/logs', () => import('./functions/api/admin/logs.js')],
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * 静态资源：仅服务 /admin/ 目录
 * 屏蔽隐藏文件（.env 等）与目录穿越，避免源码/机密泄露
 */
async function serveStatic(pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (!rel.startsWith('/admin/')) return null;

  let target = rel.slice('/admin/'.length);
  if (target === '' || target.endsWith('/')) target += 'index.html';   // 目录 -> index.html
  if (target.startsWith('.') || target.includes('..') || target.includes('\0')) return null;

  const abs = resolve(join(STATIC_ROOT, target));
  if (abs !== STATIC_ROOT && !abs.startsWith(STATIC_ROOT + sep)) return null;

  try {
    const st = await stat(abs);
    const file = st.isDirectory() ? join(abs, 'index.html') : abs;
    const buf = await readFile(file);
    return new Response(buf, {
      headers: { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' },
    });
  } catch {
    return null;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  const chunks = [];
  for await (const c of req) chunks.push(c);
  const bodyBuf = Buffer.concat(chunks);
  const noBody = req.method === 'GET' || req.method === 'HEAD';

  let response;
  try {
    const loader = ROUTES.get(url.pathname);
    if (loader) {
      const mod = await loader();
      const request = new Request(url.toString(), {
        method: req.method,
        headers: req.headers,
        body: noBody || bodyBuf.length === 0 ? undefined : bodyBuf,
      });
      // 与边缘运行时一致：提供 waitUntil 延长事件生命周期
      const waited = [];
      const ctx = { waitUntil: (p) => waited.push(Promise.resolve(p)) };
      response = await mod.onRequest({ request, env, ctx });
      await Promise.allSettled(waited);
    } else if (url.pathname === '/') {
      response = new Response(null, { status: 302, headers: { Location: '/admin/index.html' } });
    } else {
      response = await serveStatic(url.pathname);
    }
  } catch (e) {
    response = new Response(JSON.stringify({ ok: false, error: e.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  if (!response) response = new Response('not found', { status: 404 });

  res.statusCode = response.status;
  response.headers.forEach((v, k) => { res.setHeader(k, v); });
  res.end(Buffer.from(await response.arrayBuffer()));
});

server.listen(PORT, HOST, () => {
  console.log(`server listening on http://${HOST}:${PORT}`);
  console.log('  健康检查: /api/qq/health');
  console.log('  管理后台: /admin/index.html');
  console.log('  Webhook : /api/qq/webhook');
});
