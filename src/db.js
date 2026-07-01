// 极简 JSON 文件存储（MVP 规模 ≤50 客户/批，零原生依赖）
// 单文件 db.json，原子写：先写 .tmp 再 rename。
// 暴露：customers / jobs / results / sources / models
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import { encrypt, decrypt } from './crypto.js';
import { FIELDS, NUMERIC_LIKE_FIELDS, NO_RESEARCH_FIELDS } from './field-spec.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'db.json');

const DEFAULT = {
  customers: [],   // { id, customer_name, region, customer_level, ..., raw_known: {...}, manual_fields?: {...} }
  jobs: [],        // { id, models?, customer_ids, fields, status, progress, steps, started_at, finished_at, error? }
  results: [],     // { id, job_id, customer_id, field, model?, status, value?, values?, known_value?, reason?, confidence?, is_merged?, raw_result_ids?, model_summary?, created_at }
  sources: [],     // { id, result_id, url, title, evidence }
  models: [],      // ★ 模型配置（key 加密存储）
  field_defs: [],  // ★ 字段定义（中文名/解释/来源说明/数据源网址/分组/启停/顺序），由 field-spec 首次迁移
                   //   reference_urls: [{name, url}] —— 结构化数据源网址列表（指导调研优先访问的站点）
  report_versions: [], // ★ 报告版本快照 { id, customer_id, label, fields, created_at }
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

/** 删除单个客户及其全部关联数据（调研结果、来源、报告版本）。 */
export function deleteCustomer(id) {
  const s = load();
  const before = s.customers.length;
  s.customers = s.customers.filter(c => c.id !== id);
  if (s.customers.length === before) return false;
  const deadResultIds = new Set(s.results.filter(r => r.customer_id === id).map(r => r.id));
  s.results = s.results.filter(r => r.customer_id !== id);
  s.sources = s.sources.filter(src => !deadResultIds.has(src.result_id));
  s.report_versions = (s.report_versions || []).filter(v => v.customer_id !== id);
  persist();
  return true;
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
  // ★ 人工补充/修正：最高优先级，覆盖以上任何来源，status 标 'manual'
  for (const [k, v] of Object.entries(cust.manual_fields || {})) {
    const val = v == null ? '' : String(v);
    fieldMap[k] = {
      ...(fieldMap[k] || {}),
      status: 'manual',
      value: val,
      values: null,
      sources: (fieldMap[k]?.sources) || [],
      model_summary: '人工补充',
      manual: true,
    };
  }
  // 补上「最新公司名称」，与客户列表口径一致（人工修正 > 调研合并 > 原始输入 > 兜底）
  const display_name = resolveDisplayName(cust);
  return { customer: { ...cust, customer_name: display_name }, fields: fieldMap };
}

/** 解析客户「最新公司名称」：与报告口径一致。
 *  优先级：人工修正 manual_fields.customer_name
 *        > 调研合并结论 customer_name（filled/agree/conflict 有有效 value）
 *        > 用户原始输入 raw_known.customer_name
 *        > 客户记录显示名（创建时的兜底名）
 *  用于「客户列表」与「报告标题」共用，避免两处不一致。
 */
export function resolveDisplayName(customer_id) {
  const cust = typeof customer_id === 'object' ? customer_id : getCustomer(customer_id);
  if (!cust) return '';
  const pick = (v) => (v == null ? '' : String(v).trim());
  // 1) 人工修正最高优先
  const manual = pick(cust.manual_fields?.customer_name);
  if (manual) return manual;
  // 2) 调研合并结论（取 is_merged 的 customer_name 字段）
  const results = getResultsByCustomer(cust.id);
  const merged = results.find(r => r.is_merged && r.field === 'customer_name')
              || results.find(r => r.field === 'customer_name');
  if (merged && ['filled', 'agree', 'conflict'].includes(merged.status)) {
    const mv = pick(merged.value);
    if (mv) return mv;
  }
  // 3) 用户原始输入
  const known = pick(cust.raw_known?.customer_name);
  if (known) return known;
  // 4) 兜底：记录显示名
  return pick(cust.customer_name);
}

/**
 * 通用字段解析：与报告中显示的值保持一致。
 * 优先级：manual_fields > is_merged 结论 > raw_known > customer[fieldKey]
 * @param {string|object} customer_id_or_obj
 * @param {string} fieldKey
 * @returns {string}
 */
export function resolveFieldValue(customer_id_or_obj, fieldKey) {
  const cust = typeof customer_id_or_obj === 'object' ? customer_id_or_obj : getCustomer(customer_id_or_obj);
  if (!cust || !fieldKey) return '';
  const pick = (v) => (v == null ? '' : String(v).trim());
  // 1) 人工修正
  const manual = pick(cust.manual_fields?.[fieldKey]);
  if (manual) return manual;
  // 2) 调研合并结论
  const results = getResultsByCustomer(cust.id);
  const merged = results.find(r => r.is_merged && r.field === fieldKey)
              || results.find(r => r.field === fieldKey);
  if (merged && ['filled', 'agree', 'conflict'].includes(merged.status)) {
    const mv = pick(merged.value);
    if (mv) return mv;
  }
  // 3) raw_known
  const known = pick(cust.raw_known?.[fieldKey]);
  if (known) return known;
  // 4) 兜底：客户记录上同名字段
  return pick(cust[fieldKey]);
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
/** 把明文 key 脱敏：保留首4尾4，中间用 • 代替（短 key 全部打码）。 */
function maskKey(plain) {
  const s = String(plain || '');
  if (!s) return '';
  if (s.length <= 8) return '•'.repeat(s.length);
  return s.slice(0, 4) + '••••••' + s.slice(-4);
}
function publicModel(m) {
  if (!m) return m;
  const { api_key_encrypted, custom_headers, ...rest } = m;
  let api_key_mask = '';
  if (api_key_encrypted) {
    try { api_key_mask = maskKey(decrypt(api_key_encrypted)); } catch { api_key_mask = '••••••••'; }
  }
  return {
    ...rest,
    custom_headers: maskHeaders(custom_headers),
    has_key: !!api_key_encrypted || hasSensitiveHeader(custom_headers),
    api_key_mask,   // 脱敏展示用（如 sk-0••••••47ac），不可用于实际请求
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
  // api_key:有值才更新(空字符串视为不修改)。任何含脱敏符号 • 的值都视为"未修改的脱敏展示值"，不覆盖。
  if (typeof patch.api_key === 'string' && patch.api_key.length > 0 && !patch.api_key.includes('•')) {
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

// ========== 客户人工补充字段 ==========
/** 设置/合并客户的人工补充字段（manual_fields），返回更新后的客户 */
export function setManualFields(customer_id, patch) {
  const s = load();
  const c = s.customers.find(x => x.id === customer_id);
  if (!c) return null;
  c.manual_fields = { ...(c.manual_fields || {}) };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null || String(v).trim() === '') delete c.manual_fields[k];
    else c.manual_fields[k] = String(v);
  }
  persist();
  return c;
}

// ========== 报告版本快照 ==========
/** 把当前客户报告存为一个版本快照（用于版本对比）。label 用于区分触发来源。 */
export function snapshotReport(customer_id, label = '') {
  const s = load();
  const report = buildCustomerReport(customer_id);
  if (!report) return null;
  const snap = {
    id: 'v_' + nanoid(8),
    customer_id,
    label: String(label || '').slice(0, 40),
    fields: report.fields,
    created_at: Date.now(),
  };
  s.report_versions.unshift(snap);
  // 每个客户最多保留 20 个版本，防止无限增长
  const own = s.report_versions.filter(v => v.customer_id === customer_id);
  if (own.length > 20) {
    const keep = new Set(own.slice(0, 20).map(v => v.id));
    s.report_versions = s.report_versions.filter(v => v.customer_id !== customer_id || keep.has(v.id));
  }
  persist();
  return snap;
}
export function listReportVersions(customer_id) {
  return load().report_versions.filter(v => v.customer_id === customer_id);
}
export function getReportVersion(id) {
  return load().report_versions.find(v => v.id === id);
}

// ========== 字段定义（查询字段管理）==========
const VALID_GROUPS = ['basic','app','product','biz','data','collection','people','goal','meta','custom'];
/** 分组允许标准 key，也允许用户自定义分组名（中文等任意非空串，≤30 字）。空则归入 custom。 */
function sanitizeGroup(g) {
  const s = String(g == null ? '' : g).trim().slice(0, 30);
  return s || 'custom';
}

export function listFieldDefs({ activeOnly = false } = {}) {
  let arr = load().field_defs.slice().sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  if (activeOnly) arr = arr.filter(f => f.enabled !== false);
  return arr;
}
export function getFieldDef(key) {
  return load().field_defs.find(f => f.key === key);
}
export function createFieldDef(input) {
  const s = load();
  const now = Date.now();
  const maxOrder = s.field_defs.reduce((m, f) => Math.max(m, f.order ?? 0), 0);
  // 允许传入自定义 key（内置/课件级字段），但不能与现有 key 冲突
  let keyId;
  if (input.key && typeof input.key === 'string' && /^[a-z][a-z0-9_]{1,63}$/i.test(input.key)) {
    if (s.field_defs.some(x => x.key === input.key)) {
      throw new Error('字段 key 已存在：' + input.key);
    }
    keyId = input.key;
  } else {
    keyId = 'f_' + nanoid(8);
  }
  const f = {
    key: keyId,
    label: String(input.label || '').trim() || '未命名字段',
    group: sanitizeGroup(input.group),
    hint: String(input.hint || '').trim(),
    source_note: String(input.source_note || '').trim(),
    reference_urls: sanitizeReferenceUrls(input.reference_urls),
    numeric: !!input.numeric,
    no_research: !!input.no_research,
    enabled: input.enabled !== false,
    builtin: false,
    order: maxOrder + 1,
    created_at: now,
    updated_at: now,
  };
  s.field_defs.push(f);
  persist();
  return f;
}
export function updateFieldDef(key, patch) {
  const s = load();
  const f = s.field_defs.find(x => x.key === key);
  if (!f) return null;
  for (const k of ['label','group','hint','source_note','numeric','no_research','enabled','order']) {
    if (k in patch) f[k] = patch[k];
  }
  if ('reference_urls' in patch) f.reference_urls = sanitizeReferenceUrls(patch.reference_urls);
  if ('group' in patch) f.group = sanitizeGroup(patch.group);
  f.updated_at = Date.now();
  persist();
  return f;
}

/** 规范化 reference_urls：去除无效项、修剪空白、上限 20 条。
 *  接受 [{name, url}] 或字符串数组（自动拆为 {name:'', url}）。 */
function sanitizeReferenceUrls(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map(it => {
      if (!it) return null;
      if (typeof it === 'string') return { name: '', url: it.trim() };
      const name = String(it.name || '').trim();
      const url = String(it.url || '').trim();
      if (!name && !url) return null;
      return { name, url };
    })
    .filter(Boolean)
    .slice(0, 20);
}
export function deleteFieldDef(key) {
  const s = load();
  const before = s.field_defs.length;
  s.field_defs = s.field_defs.filter(f => f.key !== key);
  if (s.field_defs.length === before) return false;
  persist();
  return true;
}

/** 批量导入字段定义：按 key 增量 upsert（有 key 且存在→更新；否则新建）。不删除现有字段。
 *  @param {Array} rows 来自 parseFieldDefs 的规范化行
 *  @returns {{created:number, updated:number}}
 */
export function importFieldDefs(rows) {
  let created = 0, updated = 0;
  const all = load().field_defs;
  for (const row of (rows || [])) {
    const patch = {
      label: row.label, hint: row.hint || '', source_note: row.source_note || '',
      group: row.group || 'custom', enabled: row.enabled !== false,
    };
    // numeric / no_research 不在导入模板中：仅当行里显式提供才写，避免覆盖内置字段已有设置
    if ('numeric' in row) patch.numeric = !!row.numeric;
    if ('no_research' in row) patch.no_research = !!row.no_research;
    // reference_urls: 导入模板若提供则覆盖；未提供则保留原值
    if ('reference_urls' in row) patch.reference_urls = row.reference_urls;
    // 无 key 列：按 key（兼容旧模板）或中文名称匹配——同名则更新，否则新建
    const existing = (row.key && getFieldDef(row.key))
      || all.find(f => f.label === row.label);
    if (existing) {
      updateFieldDef(existing.key, patch);
      updated++;
    } else {
      createFieldDef(patch);
      created++;
    }
  }
  return { created, updated };
}

/** 启动时自动迁移：仅当 db 中无任何 field_def 时，把 field-spec.js 的 FIELDS 灌入。
 *  把 sources.primary/fallback 拼成 source_note 文本，NUMERIC_LIKE_FIELDS→numeric，
 *  NO_RESEARCH_FIELDS→no_research，reference_urls 结构化数组直接保留，
 *  全部标 builtin:true（可改可停，删除给二次确认）。
 */
export function autoMigrateFieldDefs() {
  const s = load();
  if (s.field_defs.length > 0) return null;
  s.field_defs = FIELDS.map((f, i) => {
    const parts = [];
    if (f.sources?.primary?.length) parts.push('优先来源：' + f.sources.primary.join('、'));
    if (f.sources?.fallback?.length) parts.push('备选来源：' + f.sources.fallback.join('、'));
    return {
      key: f.key,
      label: f.label,
      group: f.group || 'meta',
      hint: f.hint || '',
      source_note: parts.join('；'),
      reference_urls: sanitizeReferenceUrls(f.reference_urls),
      numeric: NUMERIC_LIKE_FIELDS.has(f.key),
      no_research: NO_RESEARCH_FIELDS.has(f.key),
      enabled: true,
      builtin: true,
      order: i,
      created_at: Date.now(),
      updated_at: Date.now(),
    };
  });
  persist();
  console.log(`[autoMigrate] 已灌入 ${s.field_defs.length} 个内置字段定义到 field_defs`);
  return s.field_defs.length;
}

/** 二次迁移：给老 db 中已有的 field_defs 补 reference_urls 字段。
 *  - 缺该属性的全部补默认空数组 []
 *  - 若是内置字段（builtin:true）且 field-spec 中定义了 reference_urls，则用 field-spec 的回填
 *  幂等：只动确实需要补的记录。
 */
export function ensureReferenceUrlsField() {
  const s = load();
  let touched = 0;
  const specByKey = Object.fromEntries(FIELDS.map(f => [f.key, f]));
  for (const fd of s.field_defs) {
    if (Array.isArray(fd.reference_urls)) continue;
    const fromSpec = fd.builtin ? specByKey[fd.key]?.reference_urls : null;
    fd.reference_urls = sanitizeReferenceUrls(fromSpec);
    fd.updated_at = Date.now();
    touched++;
  }
  if (touched) {
    persist();
    console.log(`[ensureReferenceUrlsField] 已为 ${touched} 个字段补默认 reference_urls`);
  }
  return touched;
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
