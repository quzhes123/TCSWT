// 受控搜索：多 provider 适配
// 默认 Tavily（LLM 友好、1000 次/月免费、注册无需信用卡）
// 兼容 SerpAPI；可强制 SEARCH_PROVIDER 切换。
// 设计：不依赖上游 Claude 的 web_search 工具(网关可能过滤)。
// 由 Node 端发起搜索/抓取,把结果作为 user message 注入,Claude 决定哪条值得引用。

const TAVILY_KEY  = process.env.TAVILY_API_KEY  || '';
const SERPAPI_KEY = process.env.SERPAPI_API_KEY || process.env.SERPAPI_KEY || '';

// provider 显式指定优先；否则按 key 自动选
const EXPLICIT = (process.env.SEARCH_PROVIDER || '').toLowerCase();
export const PROVIDER = EXPLICIT
  || (TAVILY_KEY ? 'tavily' : (SERPAPI_KEY ? 'serpapi' : 'none'));

const SEARCH_TIMEOUT_MS = 25000;
const FETCH_TIMEOUT_MS = 15000;
const MAX_RESULTS = 6;
const MAX_SNIPPET = 280;
const MAX_PAGE_CHARS = 6000;

/** 是否启用真实搜索 */
export const SEARCH_ENABLED = PROVIDER !== 'none';

/**
 * 受控搜索：返回标准化 [{title, url, snippet, source}]
 * 无 key/未配 provider 时返回 ok=false + 明确 reason，系统不会因此崩。
 */
export async function webSearch(query, opts = {}) {
  if (!SEARCH_ENABLED) {
    return { ok: false, reason: '未配置搜索 API（请在 .env 设置 TAVILY_API_KEY 或 SERPAPI_API_KEY）', query, results: [] };
  }
  if (PROVIDER === 'tavily') return tavilySearch(query, opts);
  if (PROVIDER === 'serpapi') return serpapiSearch(query, opts);
  return { ok: false, reason: 'unknown SEARCH_PROVIDER: ' + PROVIDER, query, results: [] };
}

// ===== Tavily =====
async function tavilySearch(query, { num = MAX_RESULTS, includeDomains } = {}) {
  const body = {
    query,
    max_results: Math.min(num, 10),
    search_depth: 'basic',          // 'basic' (1 credit) | 'advanced' (2 credits)
    include_answer: false,
    include_raw_content: false,
  };
  if (includeDomains?.length) body.include_domains = includeDomains;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    const r = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Authorization': 'Bearer ' + TAVILY_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    clearTimeout(t);
    if (!r.ok) {
      let detail = '';
      try { detail = (await r.text()).slice(0, 200); } catch {}
      return { ok: false, reason: `tavily http ${r.status} ${detail}`, query, results: [] };
    }
    const j = await r.json();
    const out = (j.results || []).slice(0, num).map(it => ({
      title: it.title || '',
      url: it.url || '',
      snippet: String(it.content || '').slice(0, MAX_SNIPPET),
      source: it.url ? safeHost(it.url) : '',
      score: typeof it.score === 'number' ? it.score : null,
    }));
    return { ok: true, query, results: out, provider: 'tavily' };
  } catch (e) {
    return { ok: false, reason: 'tavily error: ' + (e?.message || e), query, results: [] };
  }
}

// ===== SerpAPI（保留作为备选 provider）=====
async function serpapiSearch(query, { num = MAX_RESULTS, hl = 'zh-cn' } = {}) {
  const engine = process.env.SERPAPI_ENGINE || 'google';
  const params = new URLSearchParams({ engine, q: query, num: String(num), hl, api_key: SERPAPI_KEY });
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    const r = await fetch(`https://serpapi.com/search.json?${params}`, { signal: ctrl.signal });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: `serpapi http ${r.status}`, query, results: [] };
    const j = await r.json();
    let out = [];
    for (const it of (j.organic_results || []).slice(0, num)) {
      out.push({
        title: it.title || '',
        url: it.link || '',
        snippet: (it.snippet || it.snippet_highlighted_words?.join(' ') || '').slice(0, MAX_SNIPPET),
        source: it.displayed_link || (it.link ? safeHost(it.link) : ''),
      });
    }
    if (out.length === 0) {
      for (const it of (j.news_results || []).slice(0, num)) {
        out.push({
          title: it.title || '',
          url: it.link || '',
          snippet: (it.snippet || '').slice(0, MAX_SNIPPET),
          source: it.source || '',
        });
      }
    }
    return { ok: true, query, results: out, provider: 'serpapi' };
  } catch (e) {
    return { ok: false, reason: 'serpapi error: ' + (e?.message || e), query, results: [] };
  }
}

function safeHost(u) {
  try { return new URL(u).hostname; } catch { return ''; }
}

/**
 * 抓页面正文：去标签 + 截断；不引 cheerio。
 */
export async function fetchPage(targetUrl) {
  if (!targetUrl) return { ok: false, reason: 'empty url' };
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    const r = await fetch(targetUrl, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ShangwutongBot/0.1)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(t);
    if (!r.ok) return { ok: false, reason: `http ${r.status}`, url: targetUrl };
    const ct = r.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml|text\/plain/i.test(ct)) {
      return { ok: false, reason: 'non-html: ' + ct, url: targetUrl };
    }
    const html = await r.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_PAGE_CHARS);
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return { ok: true, url: targetUrl, title: titleMatch?.[1]?.trim() || '', text };
  } catch (e) {
    return { ok: false, reason: 'fetch error: ' + (e?.message || e), url: targetUrl };
  }
}
