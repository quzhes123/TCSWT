// 受控搜索 provider 适配器
import test from 'node:test';
import assert from 'node:assert/strict';

test('serp: 无 key 时降级到公共网页搜索（始终启用）', async () => {
  // 清掉所有可能的 key,模块缓存评估时会取 PROVIDER='none'
  delete process.env.TAVILY_API_KEY;
  delete process.env.SERPAPI_API_KEY;
  delete process.env.SERPAPI_KEY;
  delete process.env.SEARCH_PROVIDER;
  // 动态 import 才能拿到当前 env 下的模块状态
  const { SEARCH_ENABLED, PROVIDER, publicSearch } = await import('../src/serp.js?fresh=' + Date.now());
  // 新设计：公共搜索兜底始终可用，SEARCH_ENABLED 恒为 true；无 key 时 PROVIDER='none'
  assert.equal(SEARCH_ENABLED, true);
  assert.equal(PROVIDER, 'none');
  // publicSearch 对空 query 优雅失败（不发网络请求）
  const empty = await publicSearch('');
  assert.equal(empty.ok, false);
  assert.deepEqual(empty.results, []);
});

test('serp: fetchPage 空 url 优雅失败', async () => {
  const { fetchPage } = await import('../src/serp.js?fresh=' + Date.now());
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
