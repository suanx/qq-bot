/**
 * 管理后台端到端：真实 HTTP + Cookie 会话
 * 前置： node dev-server.mjs （默认 :8788）
 * 用法： node probe/admin-e2e.mjs
 */
const BASE = process.env.BASE || 'http://localhost:8788';
/** 后台口令：优先取环境变量，便于本地/云端用不同凭据 */
const PASSWORD = process.env.ADMIN_PASSWORD || 'devpass';
const USERNAME = process.env.ADMIN_USERNAME || 'admin';

let cookie = '';
let fails = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  PASS  ${name}`);
  else { fails += 1; console.log(`  FAIL  ${name} ${extra}`); }
};

async function call(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
      ...(opts.headers || {}),
    },
  });
  const setCookie = res.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  let data = {};
  try { data = await res.json(); } catch { /* 空 */ }
  return { res, data };
}

console.log('=== 1. 未登录访问受保护接口 ===');
{
  const { res } = await call('/api/admin/me');
  check('me 返回 401', res.status === 401, `实际 ${res.status}`);
  const g = await call('/api/admin/groups');
  check('groups 返回 401', g.res.status === 401, `实际 ${g.res.status}`);
}

console.log('\n=== 2. 错误口令被拒 ===');
{
  const { res, data } = await call('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: 'wrong' }),
  });
  check('登录返回 401', res.status === 401, `实际 ${res.status}`);
  check('返回错误信息', !!data.error, JSON.stringify(data));
}

console.log('\n=== 3. 正确口令登录 ===');
{
  const { res, data } = await call('/api/admin/login', {
    method: 'POST',
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  check('登录返回 200', res.status === 200, `实际 ${res.status}`);
  check('角色为 owner', data.role === 'owner', JSON.stringify(data));
  check('已下发会话 Cookie', cookie.startsWith('bot_admin_session='), cookie);
}

console.log('\n=== 4. 会话保持 ===');
{
  const { res, data } = await call('/api/admin/me');
  check('me 返回 200', res.status === 200, `实际 ${res.status}`);
  check('返回用户名', data.username === 'admin', JSON.stringify(data));
  check('返回权限', Array.isArray(data.permissions?.write), JSON.stringify(data));
}

console.log('\n=== 5. 概览数据 ===');
{
  const { res, data } = await call('/api/admin/overview');
  check('overview 返回 200', res.status === 200, `实际 ${res.status}`);
  check('包含 counts', !!data.counts, JSON.stringify(data));
  check('包含 today', !!data.today, JSON.stringify(data));
  check('包含 storage', !!data.storage, JSON.stringify(data));
}

console.log('\n=== 6. 群 CRUD ===');
let gid = 'G_TEST_001';
{
  const r = await call('/api/admin/groups', { method: 'POST', body: JSON.stringify({ id: gid, name: '测试群' }) });
  check('创建成功', r.data.ok, JSON.stringify(r.data));
  check('返回 id', r.data.item?.id === gid, JSON.stringify(r.data));

  const l = await call('/api/admin/groups?pageSize=100');
  check('列表包含新群', (l.data.items || []).some((x) => x.id === gid), JSON.stringify(l.data.items?.length));

  const u = await call('/api/admin/groups?id=' + encodeURIComponent(gid), {
    method: 'PUT', body: JSON.stringify({ name: '改名后', status: 'disabled' }),
  });
  check('更新成功', u.data.ok && u.data.item?.name === '改名后', JSON.stringify(u.data));

  const one = await call('/api/admin/groups?id=' + encodeURIComponent(gid));
  check('详情一致', one.data.item?.status === 'disabled', JSON.stringify(one.data));

  const d = await call('/api/admin/groups?id=' + encodeURIComponent(gid), { method: 'DELETE' });
  check('删除成功', d.data.ok, JSON.stringify(d.data));

  const after = await call('/api/admin/groups?pageSize=100');
  check('删除后列表不含该群', !(after.data.items || []).some((x) => x.id === gid));
}

console.log('\n=== 7. 搜索 / 筛选 / 分页 / 排序 ===');
{
  for (let i = 1; i <= 12; i++) {
    await call('/api/admin/groups', {
      method: 'POST',
      body: JSON.stringify({ id: `G_P${String(i).padStart(3, '0')}`, name: `群${i}` }),
    });
  }
  const p1 = await call('/api/admin/groups?page=1&pageSize=5&sortKey=id&sortDir=asc');
  check('分页条数正确', (p1.data.items || []).length === 5, JSON.stringify(p1.data));
  check('总数正确', p1.data.total >= 12, JSON.stringify(p1.data.total));
  check('总页数正确', p1.data.totalPages === Math.ceil(p1.data.total / 5), JSON.stringify(p1.data));
  check('升序排序正确', p1.data.items[0].id <= p1.data.items[1].id, JSON.stringify(p1.data.items?.map(i=>i.id)));

  const s = await call('/api/admin/groups?search=' + encodeURIComponent('群3'));
  check('搜索命中', (s.data.items || []).length >= 1, JSON.stringify(s.data));

  const f = await call('/api/admin/groups?status=active');
  check('状态筛选生效', (f.data.items || []).every((x) => x.status === 'active'), JSON.stringify(f.data.items?.map(i=>i.status)));
}

console.log('\n=== 8. 校验与权限 ===');
{
  const bad = await call('/api/admin/groups', { method: 'POST', body: JSON.stringify({ name: '缺 id' }) });
  check('缺少必填字段被拒', bad.res.status === 400 && !!bad.data.error, JSON.stringify(bad.data));

  const badRole = await call('/api/admin/admins', {
    method: 'POST', body: JSON.stringify({ openid: 'X1', role: 'superuser' }),
  });
  check('非法角色被拒', badRole.res.status === 400, JSON.stringify(badRole.data));

  const badRegex = await call('/api/admin/rules', {
    method: 'POST', body: JSON.stringify({ type: 'regex', value: '([a-z' }),
  });
  check('非法正则被拒', badRegex.res.status === 400, JSON.stringify(badRegex.data));

  const okRule = await call('/api/admin/rules', {
    method: 'POST', body: JSON.stringify({ type: 'keyword', value: '测试广告词' }),
  });
  check('合法规则创建成功', okRule.data.ok, JSON.stringify(okRule.data));

  const logDeny = await call('/api/admin/logs', { method: 'POST', body: JSON.stringify({ action: 'x' }) });
  check('日志禁止外部写入(405)', logDeny.res.status === 405, `实际 ${logDeny.res.status}`);
}

console.log('\n=== 9. 操作日志已记录 ===');
{
  const { data } = await call('/api/admin/logs?pageSize=100');
  const actions = (data.items || []).map((l) => l.action);
  check('包含 login 日志', actions.includes('login'), JSON.stringify(actions));
  check('包含 login_failed 日志', actions.includes('login_failed'), JSON.stringify(actions));
  check('包含 create 日志', actions.includes('create'), JSON.stringify(actions));
}

console.log('\n=== 10. 退出登录 ===');
{
  await call('/api/admin/logout', { method: 'POST' });
  const { res } = await call('/api/admin/me');
  check('退出后 me 返回 401', res.status === 401, `实际 ${res.status}`);
}

console.log(`\n管理后台端到端结果：${fails === 0 ? '全部通过' : fails + ' 项失败'}`);
process.exit(fails === 0 ? 0 : 1);
