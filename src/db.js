// 极简 JSON 文件存储（MVP 规模 ≤50 客户/批，零原生依赖）
// 单文件 db.json，原子写：先写 .tmp 再 rename。
// 暴露：customers / jobs / results / sources / models
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { encrypt, decrypt } from './crypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'db.json');

const DEFAULT = {
  customers: [],   // { id, customer_name, region, customer_level, ..., raw_known: {...} }
  jobs: [],        // { id, models?, customer_ids, fields, status, progress, steps, started_at, finished_at, error? }
  results: [],     // { id, job_id, customer_id, field, model?, status, value?, values?, known_value?, reason?, confidence?, is_merged?, raw_result_ids?, model_summary?, created_at }
  sources: [],     // { id, result_id, url, title, evidence }
  models: [],      // ★ 新：模型配置（key 加密存储）
};

let _state = null;

function load() {
  if (_state) return _state;
  if (fs.existsSync(DB_PATH)) {
    try { _state = JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); }
    catch { _state = structuredClone(DEFAULT); }
  } else {
    _state = structuredClone(DEFAULT);
  }
  // 兼容老库
  for (const k of Object.keys(DEFAULT)) if (!Array.isArray(_state[k])) _state[k] = [];
  // 一次性自愈：清掉空 url 的 sources（旧版本残留）以及孤儿 sources
  const validResultIds = new Set(_state.results.map(r => r.id));
  const before = _state.sources.length;
  _state.sources = _state.sources.filter(s => s && s.url && validResultIds.has(s.result_id));
  if (_state.sources.length !== before) persist();
  return _state;
}

function persist() {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const tmp = DB_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_state, null, 2));
  fs.renameSync(tmp, DB_PATH);
}

// ========== Customers ==========
export function listCustomers() { return load().customers.slice(); }
export function getCustomer(id) { return load().customers.find(c => c.id === id); }
export function replaceCustomers(customers) {
  const s = load();
  s.customers = customers.map(c => ({ id: c.id || nanoid(10), ...c }));
  persist();
  return s.customers;
}
export function addCustomer(customer) {
  const s = load();
  // 同名复用：如果已存在同名客户直接返回，不重复创建
  const exist = s.customers.find(c => c.customer_name === customer.customer_name);
  if (exist) return exist;
  const c = { id: nanoid(10), region: '', customer_level: '', business_line: '', product_type: '', raw_known: {}, ...customer };
  s.customers.push(c);
  persist();
  return c;
}
/** 更新客户的显示名（用于调研后从兜底名 "APP @ 区域" 升级为真实公司名）。
 *  仅在新名字与现有名字不同且新名字非空时更新；遇到同名冲突保持原状不抛错。
 */
export function updateCustomerName(id, newName) {
  const s = load();
  const c = s.customers.find(x => x.id === id);
  if (!c) return null;
  const name = String(newName || '').trim();
  if (!name || name === c.customer_name) return c;
  // 防止与已有客户重名
  if (s.customers.some(x => x.id !== id && x.customer_name === name)) return c;
  c.customer_name = name;
  // 同步把 raw_known.customer_name 也补上（之后报告/导出会展示）
  c.raw_known = c.raw_known || {};
  if (!c.raw_known.customer_name) c.raw_known.customer_name = name;
  persist();
  return c;
}
export function clearAll() {
  _state = structuredClone(DEFAULT);
  persist();
}

// ========== Jobs ==========
export function createJob(job) {
  const s = load();
  const j = { id: nanoid(10), status: 'pending', progress: { done: 0, total: 0 }, started_at: Date.now(), ...job };
  s.jobs.unshift(j);
  persist();
  return j;
}
export function updateJob(id, patch) {
  const s = load();
  const j = s.jobs.find(x => x.id === id);
  if (!j) return null;
  Object.assign(j, patch);
  persist();
  return j;
}
export function getJob(id) { return load().jobs.find(j => j.id === id); }
export function listJobs() { return load().jobs.slice(); }

// ========== Results ==========
// 唯一性策略（多模型）：
//   - 写"原始结果" (is_merged 不传或 false)：清掉同 (customer_id, field, model) 的旧原始
//     并清掉旧 job 的合并结论(防止旧合并指向不存在的原始 raw_result_ids)
//   - 写"合并结论" (is_merged=true)：清掉同 (customer_id, field) 的旧合并；不动同 job_id 的原始
// 这样多模型每次重跑会清掉同 (cust,field) 的全部旧记录,但同 job 内原始与合并能共存。
export function saveResult(result, sources = []) {
  const s = load();
  const id = nanoid(12);
  const isMerged = !!result.is_merged;
  let staleIds;
  if (isMerged) {
    // 写合并：清同 (cust,field) 的旧合并(肯定是上次 job 留的)
    staleIds = new Set(s.results
      .filter(r => r.customer_id === result.customer_id && r.field === result.field && r.is_merged)
      .map(r => r.id));
  } else {
    // 写原始：清同 (cust,field,model) 的旧原始 + 清掉同 (cust,field) 的旧合并(旧合并的原始已失效)
    staleIds = new Set(s.results
      .filter(r => r.customer_id === result.customer_id && r.field === result.field
                   && (r.is_merged
                       || (!r.is_merged && r.model === result.model)))
      .map(r => r.id));
  }
  s.results = s.results.filter(r => !staleIds.has(r.id));
  s.sources = s.sources.filter(src => !staleIds.has(src.result_id));
  s.results.push({ id, created_at: Date.now(), ...result });
  for (const src of (sources || [])) {
    if (!src || typeof src !== 'object') continue;
    const url = String(src.url || '').trim();
    if (!url) continue;
    s.sources.push({
      id: nanoid(10),
      result_id: id,
      url,
      title: String(src.title || '').slice(0, 200),
      evidence: String(src.evidence || '').slice(0, 500),
    });
  }
  persist();
  return id;
}
export function listResults(filter = {}) {
  let arr = load().results.slice();
  if (filter.job_id)      arr = arr.filter(r => r.job_id === filter.job_id);
  if (filter.customer_id) arr = arr.filter(r => r.customer_id === filter.customer_id);
  if (filter.field)       arr = arr.filter(r => r.field === filter.field);
  if (filter.merged === true)  arr = arr.filter(r => r.is_merged);
  if (filter.merged === false) arr = arr.filter(r => !r.is_merged);
  return arr;
}
export function getResultsByCustomer(customer_id) {
  return load().results.filter(r => r.customer_id === customer_id);
}
export function listSourcesByResult(result_id) {
  return load().sources.filter(s => s.result_id === result_id);
}

// ========== 聚合：客户调查报告（用于前端 / V2 导出）==========
export function buildCustomerReport(customer_id) {
  const cust = getCustomer(customer_id);
  if (!cust) return null;
  const results = getResultsByCustomer(customer_id);
  const fieldMap = {};
  // 只取合并结论（is_merged=true），原始结果作为 raw_results 附带（用于前端 hover 展示一致性）
  for (const r of results) {
    if (r.is_merged) {
      const rawResults = results.filter(x => !x.is_merged && x.field === r.field)
        .map(x => ({ model: x.model, status: x.status, value: x.value, sources: listSourcesByResult(x.id) }));
      fieldMap[r.field] = {
        status: r.status,
        value: r.value,
        values: r.values,
        known_value: r.known_value,
        reason: r.reason,
        confidence: r.confidence,
        model_summary: r.model_summary || '',   // ★ 新增
        raw_results: rawResults,                 // ★ 新增
        sources: listSourcesByResult(r.id),
      };
    }
  }
  // 向后兼容：旧数据可能没 is_merged 标记，则按旧逻辑兜底（取最新一条）
  for (const r of results) {
    if (!fieldMap[r.field]) {
      fieldMap[r.field] = {
        status: r.status,
        value: r.value,
        values: r.values,
        known_value: r.known_value,
        reason: r.reason,
        confidence: r.confidence,
        model_summary: r.model_summary || '',
        raw_results: [],
        sources: listSourcesByResult(r.id),
      };
    }
  }
  // 已知字段（未被 LLM 处理）原样补进去
  for (const [k, v] of Object.entries(cust.raw_known || {})) {
    if (fieldMap[k]) continue;
    if (v) fieldMap[k] = { status: 'known', value: v, sources: [], model_summary: '', raw_results: [] };
  }
  return { customer: cust, fields: fieldMap };
}

// ========== 看板统计 ==========
export function computeStats() {
  const customers = load().customers;
  const byLevel = {}, byRegion = {}, byBizLine = {};
  for (const c of customers) {
    const lvl = c.customer_level || '未分级';
    const reg = c.region || '未知';
    const biz = c.business_line || c.product_type || '未分类';
    byLevel[lvl] = (byLevel[lvl] || 0) + 1;
    byRegion[reg] = (byRegion[reg] || 0) + 1;
    byBizLine[biz] = (byBizLine[biz] || 0) + 1;
  }
  return {
    total: customers.length,
    byLevel, byRegion, byBizLine,
    pendingJobs: load().jobs.filter(j => j.status === 'running' || j.status === 'pending').length,
  };
}

// ========== Models（多模型配置）==========
// 公开返回：永远不带 api_key 密文,且对 custom_headers 中的敏感值脱敏（防止明文泄漏）
const SENSITIVE_HEADER_KEYS = /^(authorization|x-api-key|x-goog-api-key|api-key|cookie|x-auth-token)$/i;
function maskHeaders(headers) {
  if (!headers || typeof headers !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (SENSITIVE_HEADER_KEYS.test(k)) {
      out[k] = v ? '••••••••' : '';
    } else {
      out[k] = v;
    }
  }
  return out;
}
function publicModel(m) {
  if (!m) return m;
  const { api_key_encrypted, custom_headers, ...rest } = m;
  return {
    ...rest,
    custom_headers: maskHeaders(custom_headers),
    has_key: !!api_key_encrypted || hasSensitiveHeader(custom_headers),
  };
}
function hasSensitiveHeader(headers) {
  if (!headers) return false;
  return Object.keys(headers).some(k => SENSITIVE_HEADER_KEYS.test(k) && !!headers[k]);
}
export function listModels({ enabledOnly = false } = {}) {
  const list = load().models.slice();
  return (enabledOnly ? list.filter(m => m.enabled !== false) : list).map(publicModel);
}
export function getModel(id) {
  return publicModel(load().models.find(m => m.id === id));
}
/** 内部使用：拿到含明文 api_key 的完整对象（仅 driver 调用时用） */
export function getModelWithSecret(id) {
  const m = load().models.find(x => x.id === id);
  if (!m) return null;
  return { ...m, api_key: m.api_key_encrypted ? decrypt(m.api_key_encrypted) : '' };
}
export function createModel(input) {
  const s = load();
  const now = Date.now();
  const m = {
    id: 'm_' + nanoid(8),
    name: String(input.name || '').trim() || '未命名模型',
    identifier: String(input.identifier || '').trim(),
    provider: String(input.provider || '').trim() || 'custom',
    version: input.version || '',
    description: input.description || '',
    api_url: String(input.api_url || '').trim(),
    auth_type: input.auth_type || 'bearer',           // bearer | api_key_header | custom_header | none
    api_key_encrypted: input.api_key ? encrypt(input.api_key) : '',
    custom_headers: input.custom_headers || {},
    timeout: parseInt(input.timeout) || 120,
    max_retries: parseInt(input.max_retries) || 3,
    concurrency: parseInt(input.concurrency) || 4,
    request_template: input.request_template || null,
    response_path: input.response_path || '',
    enabled: input.enabled !== false,
    last_test_at: null,
    last_test_ok: null,
    last_test_error: '',
    created_at: now,
    updated_at: now,
  };
  s.models.push(m);
  persist();
  return publicModel(m);
}
export function updateModel(id, patch) {
  const s = load();
  const m = s.models.find(x => x.id === id);
  if (!m) return null;
  const fields = ['name','identifier','provider','version','description',
                  'api_url','auth_type','timeout','max_retries',
                  'concurrency','request_template','response_path','enabled'];
  for (const k of fields) if (k in patch) m[k] = patch[k];
  // custom_headers: 占位值 ••••••• 视为"保持原值",只更新非占位字段
  if (patch.custom_headers && typeof patch.custom_headers === 'object') {
    const merged = { ...(m.custom_headers || {}) };
    for (const [k, v] of Object.entries(patch.custom_headers)) {
      const isMask = typeof v === 'string' && /^•+$/.test(v);
      if (!isMask) merged[k] = v;
    }
    // 用户可能删了某个 header(前端不传该 key) → 我们这里保守保留旧值,如需删除让 UI 显式发 null
    m.custom_headers = merged;
  }
  // api_key:有值才更新(空字符串视为不修改),前端用 '' 表示"保持原值"
  if (typeof patch.api_key === 'string' && patch.api_key.length > 0 && patch.api_key !== '••••••••') {
    m.api_key_encrypted = encrypt(patch.api_key);
  }
  m.updated_at = Date.now();
  persist();
  return publicModel(m);
}
export function deleteModel(id) {
  const s = load();
  const before = s.models.length;
  s.models = s.models.filter(m => m.id !== id);
  if (s.models.length === before) return false;
  persist();
  return true;
}
export function recordModelTest(id, ok, errorMsg = '') {
  const s = load();
  const m = s.models.find(x => x.id === id);
  if (!m) return null;
  m.last_test_at = Date.now();
  m.last_test_ok = !!ok;
  m.last_test_error = ok ? '' : String(errorMsg).slice(0, 300);
  persist();
  return publicModel(m);
}

/** 启动时自动迁移：仅当 db 中无任何 model 且 .env 配置了 ANTHROPIC_* 时，建一条默认记录。
 *  云部署没有 .env 是常态——此时直接跳过，引导用户从「模型管理」页面手动新增即可。
 *  设计原则：所有模型配置最终都应通过 UI 录入并加密落库，不依赖 .env 同步。
 */
export function autoMigrateModels() {
  const s = load();
  if (s.models.length > 0) return null;
  const url = process.env.ANTHROPIC_BASE_URL || '';
  const key = process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || '';
  if (!key || !url) {
    console.log('[autoMigrate] 跳过（远程部署常态：无 .env 配置）。请到「模型管理」手动新增模型');
    return null;
  }
  const m = createModel({
    name: 'Claude Opus 4.8（默认）',
    identifier: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
    provider: 'anthropic',
    api_url: url.replace(/\/$/, '') + '/v1/messages',
    auth_type: 'bearer',
    api_key: key,
    custom_headers: { 'anthropic-version': '2023-06-01' },
    enabled: true,
    description: '系统首次启动从 .env 自动迁移',
  });
  console.log('[autoMigrate] 已从 .env 创建默认 Anthropic 模型: ' + m.id);
  return m;
}
