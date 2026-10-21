/**
 * 广告/垃圾信息检测
 * 内置规则 + 环境变量自定义关键词/正则 + 管理后台动态规则
 * 返回 { hit, rule, matched }
 */

const URL_RE = /(https?:\/\/|www\.)[^\s，。,、]+/i;
const TENCENT_RE = /(qq\.com|qmqq\.com|qun\.qq)/i;
const CONTACT_RE = /(?:加|添|\+|联系)\s*(?:我|下|一下)?\s*(?:v|vx|V|VX|微|薇|威|qq|QQ|q|Q|扣)\s*(?:号|信)?\s*[:：]?\s*[0-9A-Za-z]{4,}/;
const MONEY_RE = /(免费领取|扫码|二维码|低价|代刷|刷单|兼职|日结|返利|优惠券|折扣|秒杀|红包|福利群|内部群|招商|代理|加盟|变现|引流|推广|曝光|上首页)/;
const FLOOD_RE = /(.)\1{9,}/;              // 同字符刷屏
const INVITE_RE = /(群[号聊]\s*[:：]?\s*\d{6,}|邀请码|邀请链接)/;

const BUILTIN = [
  { rule: 'url', re: URL_RE },
  { rule: 'tencent-link', re: TENCENT_RE },
  { rule: 'contact', re: CONTACT_RE },
  { rule: 'money-bait', re: MONEY_RE },
  { rule: 'flood', re: FLOOD_RE },
  { rule: 'invite', re: INVITE_RE },
];

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function checkAd(text, cfg, extra = {}) {
  const t = String(text || '').trim();
  if (!t) return { hit: false };

  // 自定义关键词（后台动态规则优先，其次环境变量）
  for (const kw of [...(extra.keywords || []), ...cfg.AD_KEYWORDS]) {
    if (t.toLowerCase().includes(kw.toLowerCase())) {
      return { hit: true, rule: 'keyword', matched: kw };
    }
  }
  // 自定义正则（后台动态规则优先，其次环境变量）
  for (const p of [...(extra.regex || []), ...cfg.AD_REGEX]) {
    try {
      const m = t.match(new RegExp(p, 'i'));
      if (m) return { hit: true, rule: 'regex', matched: m[0] };
    } catch { /* 忽略非法正则 */ }
  }
  // 内置规则
  for (const { rule, re } of BUILTIN) {
    const m = t.match(re);
    if (m) return { hit: true, rule, matched: m[0] };
  }
  return { hit: false };
}
