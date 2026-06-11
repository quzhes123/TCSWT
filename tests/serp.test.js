// 受控搜索 provider 适配器
import test from 'node:test';
import assert from 'node:assert/strict';

test('serp: 无 key 时优雅降级', async () => {
  // 清掉所有可能的 key,模块缓存评估时会取 PROVIDER='none'
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPAPI_API_KEY;
  delete process.env.SERPAPI_KEY;
  delete process.env.SEARCH_PROVIDER;
  // 动态 import 才能拿到当前 env 下的模块状态
  const { webSearch, fetchPage, SEARCH_ENABLED, PROVIDER } = await import('../src/serp.js?fresh=' + Date.now());
  assert.equal(SEARCH_ENABLED, false);
  assert.equal(PROVIDER, 'none');
  const r = await webSearch('test');
  assert.equal(r.ok, false);
  assert.match(r.reason, /TAVILY_API_KEY|SERPAPI_API_KEY/);
  assert.deepEqual(r.results, []);
  const f = await fetchPage('');
  assert.equal(f.ok, false);
});

test('serp: provider 选择优先级（tavily > serpapi）', async () => {
  process.env.TAVILY_API_KEY = 'tvly-fake-test';
  process.env.SERPAPI_API_KEY = 'serp-fake-test';
  delete process.env.SEARCH_PROVIDER;
  const { PROVIDER } = await import('../src/serp.js?fresh=' + Date.now());
  assert.equal(PROVIDER, 'tavily');
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPAPI_API_KEY;
});

test('serp: SEARCH_PROVIDER 显式覆盖', async () => {
  process.env.TAVILY_API_KEY = 'tvly-fake';
  process.env.SEARCH_PROVIDER = 'serpapi';
  process.env.SERPAPI_API_KEY = 'serp-fake';
  const { PROVIDER } = await import('../src/serp.js?fresh=' + Date.now());
  assert.equal(PROVIDER, 'serpapi');
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPAPI_API_KEY;
  delete process.env.SEARCH_PROVIDER;
});
