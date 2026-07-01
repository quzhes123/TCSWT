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

// Tavily 用量超限（432）/限流（429）后，进程级粘滞降级到 SerpAPI（如果配置了）或公共搜索，
// 避免后续每个字段都先撞一次 432 再降级（省时间、止损）。
let tavilyExhausted = false;

/** 公共搜索始终可用（无需 key），用作 Tavily 超限后的兜底 */
export const SEARCH_ENABLED = true;

/** 判断 Tavily 响应是否属于「用量超限/限流」——需要降级到公共搜索 */
function isTavilyQuotaError(status) {
  return status === 432 || status === 429;
}

/**
 * 受控搜索：返回标准化 [{title, url, snippet, source}]
 * 无 key/未配 provider 时返回 ok=false + 明确 reason，系统不会因此崩。
 */
export async function webSearch(query, opts = {}) {
  if (!SEARCH_ENABLED) {
    return { ok: false, reason: '未配置搜索 API（请在 .env 设置 TAVILY_API_KEY 或 SERPAPI_API_KEY）', query, results: [] };
  }
  // 已知 Tavily 超限：优先尝试 SerpAPI（如有 key），否则走公共搜索
  if (PROVIDER === 'tavily' && tavilyExhausted) {
    if (SERPAPI_KEY) {
      const serp = await serpapiSearch(query, opts);
      if (serp.ok) return serp;
      // SerpAPI 也失败 → 降级公共搜索
    }
    return publicSearch(query, opts);
  }
  if (PROVIDER === 'tavily') {
    const r = await tavilySearch(query, opts);
    // 432/429 用量超限 → 优先尝试 SerpAPI（如有 key），否则走公共搜索
    if (!r.ok && r.quotaExceeded) {
      tavilyExhausted = true;
      if (SERPAPI_KEY) {
        const serp = await serpapiSearch(query, opts);
        if (serp.ok) {
          serp.degraded = 'tavily_quota_exceeded_fallback_serpapi';
          return serp;
        }
      }
      const pub = await publicSearch(query, opts);
      if (pub.ok) pub.degraded = 'tavily_quota_exceeded_fallback_public';
      return pub;
    }
    return r;
  }
  if (PROVIDER === 'serpapi') return serpapiSearch(query, opts);
  // 未配置任何付费 provider：直接用公共搜索
  return publicSearch(query, opts);
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
      const quotaExceeded = isTavilyQuotaError(r.status);
      return { ok: false, reason: `tavily http ${r.status} ${detail}`, quotaExceeded, query, results: [] };
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

// ===== 公共网页搜索（Brave Search HTML，无需 API key）=====
// 作为 Tavily 用量超限后的兜底；从公开搜索结果页解析标题/链接/摘要。
const PUBLIC_UA = 'Mozilla/5.0 (X11; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0';

// 公共搜索串行节流：免费端点对并发/突发很敏感，串行 + 间隔可显著降低 429/封禁概率。
const PUBLIC_MIN_INTERVAL_MS = 1500;
let _publicChain = Promise.resolve();
let _lastPublicAt = 0;

function throttlePublic(fn) {
  const run = _publicChain.then(async () => {
    const wait = PUBLIC_MIN_INTERVAL_MS - (Date.now() - _lastPublicAt);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    try { return await fn(); }
    finally { _lastPublicAt = Date.now(); }
  });
  // 链条不因单次失败中断
  _publicChain = run.then(() => {}, () => {});
  return run;
}

export async function publicSearch(query, opts = {}) {
  if (!query || !String(query).trim()) {
    return { ok: false, reason: 'empty query', query, results: [] };
  }
  return throttlePublic(() => braveSearchOnce(query, opts));
}

async function braveSearchOnce(query, { num = MAX_RESULTS, _retried = false } = {}) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
    const url = 'https://search.brave.com/search?q=' + encodeURIComponent(query) + '&source=web';
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': PUBLIC_UA,
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    clearTimeout(t);
    // 429 限流：退避后重试一次
    if (r.status === 429 && !_retried) {
      await new Promise(res => setTimeout(res, 3000));
      return braveSearchOnce(query, { num, _retried: true });
    }
    if (!r.ok) return { ok: false, reason: `public search http ${r.status}`, query, results: [] };
    const html = await r.text();
    if (/CAPTCHA|captcha|verify you are|unusual traffic/i.test(html) && !/result-wrapper/.test(html)) {
      return { ok: false, reason: 'public search blocked (captcha)', query, results: [] };
    }
    const results = parseBraveResults(html, num);
    if (results.length === 0) {
      return { ok: false, reason: 'public search returned no parseable results', query, results: [] };
    }
    return { ok: true, query, results, provider: 'public:brave' };
  } catch (e) {
    return { ok: false, reason: 'public search error: ' + (e?.message || e), query, results: [] };
  }
}

/** 解析 Brave Search 结果页 HTML → [{title,url,snippet,source}] */
function parseBraveResults(html, num = MAX_RESULTS) {
  const out = [];
  const blocks = String(html).split(/class="result-wrapper/).slice(1);
  for (const b of blocks) {
    const urlM = b.match(/<a[^>]+href="(https?:\/\/[^"]+)"[^>]*class="[^"]*\bl1\b[^"]*"/i)
              || b.match(/<a[^>]+class="[^"]*\bl1\b[^"]*"[^>]*href="(https?:\/\/[^"]+)"/i)
              || b.match(/href="(https?:\/\/[^"]+)"/i);
    if (!urlM) continue;
    const url = urlM[1];
    if (/brave\.com|search\.brave|imgs\.search/.test(url)) continue;
    const titleM = b.match(/class="title[^"]*"[^>]*title="([^"]+)"/i)
               || b.match(/class="title[^"]*">([\s\S]*?)<\/div>/i);
    const snipM  = b.match(/class="content [^"]*">([\s\S]*?)<\/div>/i);
    out.push({
      title:   titleM ? stripTags(titleM[1]).slice(0, 160) : '',
      url,
      snippet: snipM ? stripTags(snipM[1]).slice(0, MAX_SNIPPET) : '',
      source:  safeHost(url),
    });
    if (out.length >= num) break;
  }
  return out;
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
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
