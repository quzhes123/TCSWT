// 信贷监控星盘（Surfun）数据抽取模块
// 登录拿 token（内存缓存 + 过期重登）→ 查询 APP 上架监控数据（下载量/评分/排名/开发者）
//
// 用途：APP 类字段（累计下载/月均增长/排名/趋势）的数据藏在星盘登录墙后，
//       公开搜索抓不到 —— 本模块用账号直连星盘 API 取数。
//
// 凭证：从 .env 读 SURFUN_ACCOUNT / SURFUN_PASSWORD（已被 .gitignore 排除，不入库不进 git）
//
// 接口规格（逆向自前端 bundle）：
//   登录: POST https://api.surfun.cn/api/user/login  {account, password, type:1}  → data.token
//   数据: GET  https://star.surfun.cn/Admin/MarketOnlineList
//         header: Authorization + HTTP_TOKEN = "Bearer <token>"
//         query : platform(1=GooglePlay,2=AppStore,必填) + region(两字母国码) + app_name(模糊) + page_number + page_size

const LOGIN_URL = 'https://api.surfun.cn/api/user/login';
const DATA_URL  = 'https://star.surfun.cn/Admin/MarketOnlineList';

const ACCOUNT  = process.env.SURFUN_ACCOUNT  || '';
const PASSWORD = process.env.SURFUN_PASSWORD || '';
export const SURFUN_ENABLED = !!(ACCOUNT && PASSWORD);

const TIMEOUT_MS = 15000;

// 中文/英文国家名 → 星盘 region 两字母码
const REGION_MAP = {
  '墨西哥': 'mx', 'mexico': 'mx', 'mx': 'mx',
  '印尼': 'id', '印度尼西亚': 'id', 'indonesia': 'id', 'id': 'id',
  '菲律宾': 'ph', 'philippines': 'ph', 'ph': 'ph',
  '泰国': 'th', 'thailand': 'th', 'th': 'th',
  '越南': 'vn', 'vietnam': 'vn', 'vn': 'vn',
  '巴基斯坦': 'pk', 'pakistan': 'pk', 'pk': 'pk',
  '哥伦比亚': 'co', 'colombia': 'co', 'co': 'co',
  '尼日利亚': 'ng', 'nigeria': 'ng', 'ng': 'ng',
  '印度': 'in', 'india': 'in', 'in': 'in',
  '巴西': 'br', 'brazil': 'br', 'br': 'br',
};

/** 把客户的 region 文本（可能含多个国家/中文）解析为星盘 region 码列表 */
export function resolveRegions(regionText) {
  const s = String(regionText || '').toLowerCase();
  const hits = [];
  for (const [k, v] of Object.entries(REGION_MAP)) {
    if (s.includes(k.toLowerCase()) && !hits.includes(v)) hits.push(v);
  }
  return hits; // 可能为空（未识别）
}

// token 内存缓存
let _token = null;
let _tokenExp = 0;

async function fetchWithTimeout(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

/** 登录获取 token（带缓存，过期前 5 分钟刷新） */
async function getToken() {
  const now = Date.now();
  if (_token && now < _tokenExp - 5 * 60 * 1000) return _token;
  const r = await fetchWithTimeout(LOGIN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ account: ACCOUNT, password: PASSWORD, type: 1 }),
  });
  const j = await r.json();
  if (j.code !== 0 && j.code !== '0') throw new Error('星盘登录失败: ' + (j.message || j.error_message || JSON.stringify(j).slice(0, 100)));
  _token = j.data.token;
  _tokenExp = now + (Number(j.data.expires_in) || 3600) * 1000;
  return _token;
}

/**
 * 查询某 APP 在星盘的上架监控数据。
 * @param {string} appName  APP 名（模糊匹配）
 * @param {object} [opts]
 * @param {string} [opts.region]   星盘 region 码（mx/id/...）；不传则不限国家
 * @param {number} [opts.platform] 1=GooglePlay(默认) 2=AppStore
 * @returns {Promise<{ok:boolean, reason?:string, items?:Array, query?:object}>}
 *   item: { app_name, app_id, installs, score, rank, developer, url, updated, online_text, platform }
 */
export async function searchApp(appName, { region, platform = 1 } = {}) {
  if (!SURFUN_ENABLED) return { ok: false, reason: '未配置星盘账号（SURFUN_ACCOUNT / SURFUN_PASSWORD）' };
  if (!appName || !String(appName).trim()) return { ok: false, reason: 'appName 为空' };
  try {
    const token = await getToken();
    const auth = 'Bearer ' + token;
    const params = { page_number: 1, page_size: 10, app_name: String(appName).trim(), platform };
    if (region) params.region = region;
    const r = await fetchWithTimeout(DATA_URL + '?' + new URLSearchParams(params).toString(), {
      headers: { 'Authorization': auth, 'HTTP_TOKEN': auth },
    });
    const text = await r.text();
    let p; try { p = JSON.parse(text); } catch { return { ok: false, reason: '星盘返回非 JSON: ' + text.slice(0, 80) }; }
    if (p.error_no && p.error_no !== 0) return { ok: false, reason: '星盘错误: ' + (p.error_message || p.error_no), query: params };
    const list = p?.data?.list || [];
    const items = list.map(a => ({
      app_name: a.app_name, app_id: a.app_id,
      installs: a.installs, score: a.score, rank: a.rank,
      developer: a.developer, url: a.url, updated: a.updated,
      online_text: a.online_text, platform: a.platform,
    }));
    return { ok: true, items, query: params };
  } catch (e) {
    return { ok: false, reason: '星盘请求异常: ' + (e?.message || e) };
  }
}

/**
 * 高层封装：给定 APP 名 + 客户区域文本，返回最佳匹配的指标。
 * 自动解析区域；多国时逐个尝试；GooglePlay 无结果再试 AppStore。
 * @returns {Promise<{ok:boolean, reason?:string, best?:object, sourceUrl?:string}>}
 */
export async function lookupAppMetrics(appName, regionText) {
  if (!SURFUN_ENABLED) return { ok: false, reason: '未配置星盘账号' };
  // 缓存存"进行中的 Promise"：并发多字段查同一 APP 时复用同一次查询，
  // 既保证结果一致（同一 platform/region），又避免重复请求与竞态。5 分钟内有效。
  const ck = String(appName).trim().toLowerCase() + '|' + String(regionText || '').toLowerCase();
  const cached = _appCache.get(ck);
  if (cached && Date.now() - cached.t < 5 * 60 * 1000) return cached.p;

  const p = (async () => {
    const regions = resolveRegions(regionText);
    const FALLBACK_REGIONS = ['mx', 'id', 'ph', 'th', 'vn', 'co', 'pk', 'ng', 'br', 'in'];
    const tryList = regions.length ? regions : FALLBACK_REGIONS;
    for (const platform of [1, 2]) {       // 先 GooglePlay 再 AppStore
      for (const region of tryList) {
        const r = await searchApp(appName, { region, platform });
        if (r.ok && r.items.length) {
          const best = r.items.slice().sort((a, b) => (Number(b.installs) || 0) - (Number(a.installs) || 0))[0];
          return {
            ok: true, best, platform, region,
            sourceUrl: 'https://star.surfun.cn/Information/OnlineMonitoring?platform=' + platform,
          };
        }
      }
    }
    return { ok: false, reason: `星盘未找到 APP「${appName}」${regions.length ? '（区域：' + regions.join('/') + '）' : '（已遍历主要市场）'}的上架监控数据` };
  })();

  _appCache.set(ck, { t: Date.now(), p });
  // 查询失败时不长期缓存失败 Promise（下次可重试）
  p.then(v => { if (!v.ok) _appCache.delete(ck); }).catch(() => _appCache.delete(ck));
  return p;
}

// 模块级 in-flight / 结果缓存（值为 Promise）
const _appCache = new Map();
