// reference_urls：字段定义结构化数据源网址 —— 规范化、迁移、域名提取
import test from 'node:test';
import assert from 'node:assert/strict';
import { FIELDS, FIELD_BY_KEY } from '../src/field-spec.js';

test('field-spec: 内置字段 reference_urls 结构合法', () => {
  for (const f of FIELDS) {
    // 允许缺省，但若存在必须是 {name,url} 数组
    if (f.reference_urls === undefined) continue;
    assert.ok(Array.isArray(f.reference_urls), `${f.key} reference_urls 应为数组`);
    for (const r of f.reference_urls) {
      assert.equal(typeof r, 'object');
      assert.ok('url' in r, `${f.key} 的 reference_url 缺 url`);
      if (r.url) assert.match(r.url, /^https?:\/\//, `${f.key} url 应为 http(s)`);
    }
  }
});

test('field-spec: 关键字段映射到正确数据源', () => {
  // APP 下载 → 信贷监控星盘
  const dl = FIELD_BY_KEY['app_total_dl'];
  assert.ok(dl.reference_urls.some(r => r.url.includes('star.surfun.cn')), 'APP下载应含信贷监控星盘');
  // 关键决策人 → LinkedIn Sales Navigator
  const dm = FIELD_BY_KEY['key_decision_maker'];
  assert.ok(dm.reference_urls.some(r => r.url.includes('linkedin.com')), '决策人应含 LinkedIn');
  // 公司名称 → 企查查
  const cn = FIELD_BY_KEY['customer_name'];
  assert.ok(cn.reference_urls.some(r => r.url.includes('qcc.com')), '公司名称应含企查查');
});

test('reference_urls: 域名提取（去 www、去重）', () => {
  // 复刻 researcher.js 的 extractIncludeDomains 逻辑做独立验证
  const extract = (spec) => {
    const refs = Array.isArray(spec?.reference_urls) ? spec.reference_urls.filter(r => r && r.url) : [];
    const domains = [];
    for (const r of refs) {
      try { const u = new URL(r.url); if (u.hostname) domains.push(u.hostname.replace(/^www\./, '')); } catch {}
    }
    return [...new Set(domains)];
  };
  const d = extract({ reference_urls: [
    { name: '企查查', url: 'https://www.qcc.com/' },
    { name: '天眼查', url: 'https://www.tianyancha.com/' },
    { name: '企查查2', url: 'https://www.qcc.com/foo' },  // 去重
    { name: '坏的', url: 'not-a-url' },                    // 跳过
  ]});
  assert.deepEqual(d, ['qcc.com', 'tianyancha.com']);
});
