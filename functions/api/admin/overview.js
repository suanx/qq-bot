/**
 * GET /api/admin/overview  数据概览仪表盘
 */
import { guard, ok } from '../../../src/admin/api.js';
import { COLLECTIONS } from '../../../src/repo.js';
import { readStats } from '../../../src/records.js';

const byTimeDesc = (a, b) =>
  String(b.createdAt || b.lastActiveAt || '').localeCompare(String(a.createdAt || a.lastActiveAt || ''));

export async function onRequest(context) {
  const { request, env } = context;
  const g = await guard(request, env, { collection: COLLECTIONS.LOGS, write: false });
  if (g.error) return g.error;
  const { repo, kv } = g;

  const [groups, members, violations, rules, logs] = await Promise.all([
    repo.list(COLLECTIONS.GROUPS),
    repo.list(COLLECTIONS.MEMBERS),
    repo.list(COLLECTIONS.VIOLATIONS),
    repo.list(COLLECTIONS.RULES),
    repo.list(COLLECTIONS.LOGS),
  ]);

  const stats = await readStats(kv);

  // 违规规则分布
  const ruleMap = new Map();
  violations.forEach((v) => {
    const k = v.rule || 'unknown';
    ruleMap.set(k, (ruleMap.get(k) || 0) + 1);
  });
  const topRules = [...ruleMap.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6);

  return ok({
    storage: { persistent: !!kv.persistent, driver: kv.persistent ? 'kv' : 'memory' },
    counts: {
      groups: groups.length,
      members: members.length,
      violations: violations.length,
      rules: rules.length,
      logs: logs.length,
    },
    today: stats.today,
    total: stats.total,
    day: stats.day,
    topRules,
    recentViolations: [...violations].sort(byTimeDesc).slice(0, 5),
    activeGroups: [...groups]
      .sort((a, b) => String(b.lastActiveAt || '').localeCompare(String(a.lastActiveAt || '')))
      .slice(0, 5)
      .map((g) => ({ id: g.id, name: g.name, lastActiveAt: g.lastActiveAt })),
  });
}

export const onRequestGet = onRequest;
