/**
 * 本地开发服务器（零依赖）
 *   :8788  ->  按 functions/ 目录结构转发到对应函数；非 API 路径按静态文件返回
 * 用法： npm run dev
 */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';

const PORT = Number(process.env.PORT) || 8788;
const ROOT = resolve('.');

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
};

async function serveStatic(pathname) {
  let rel = pathname === '/' ? '/admin/index.html' : pathname;
  try {
    const abs = resolve(join(ROOT, normalize(rel)));
    if (abs !== ROOT && !abs.startsWith(ROOT + sep)) return null; // 防目录穿越
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
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // 收集请求体（GET/HEAD 无体）
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
      const ctx = { waitUntil: (p) => { Promise.resolve(p).catch(() => {}); } };
      response = await mod.onRequest({ request, env, ctx });
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

server.listen(PORT, () => {
  console.log(`dev server: http://localhost:${PORT}`);
  console.log(`  健康检查: http://localhost:${PORT}/api/qq/health`);
  console.log(`  管理后台: http://localhost:${PORT}/admin/`);
});
