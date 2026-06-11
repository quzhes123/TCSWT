// 极简 JSON 文件存储（MVP 规模 ≤50 客户/批，零原生依赖）
// 单文件 db.json，原子写：先写 .tmp 再 rename。
// 暴露 4 类操作：customers / jobs / results / sources
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'db.json');

const DEFAULT = {
  customers: [],   // { id, customer_name, region, customer_level, ..., raw_known: {...} }
  jobs: [],        // { id, model, customer_ids, fields, status, progress: {done,total}, started_at, finished_at, error? }
  results: [],     // { id, job_id, customer_id, field, status, value?, values?, known_value?, reason?, confidence?, model, created_at }
  sources: [],     // { id, result_id, url, title, evidence }
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
export function saveResult(result, sources = []) {
  const s = load();
  const id = nanoid(12);
  // 同一 (customer_id, field) 仅保留最新（按 job 覆盖），同时清理旧 result 关联的 sources
  const stale = s.results.filter(r => r.customer_id === result.customer_id && r.field === result.field);
  const staleIds = new Set(stale.map(r => r.id));
  s.results = s.results.filter(r => !staleIds.has(r.id));
  s.sources = s.sources.filter(src => !staleIds.has(src.result_id));
  s.results.push({ id, created_at: Date.now(), ...result });
  // 来源：过滤空对象/无 url 的脏数据
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
export function listResults() { return load().results.slice(); }
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
  for (const r of results) {
    fieldMap[r.field] = {
      status: r.status,
      value: r.value,
      values: r.values,
      known_value: r.known_value,
      reason: r.reason,
      confidence: r.confidence,
      model: r.model,
      sources: listSourcesByResult(r.id),
    };
  }
  // 已知字段（未被 LLM 处理）原样补进去
  for (const [k, v] of Object.entries(cust.raw_known || {})) {
    if (fieldMap[k]) continue;
    if (v) fieldMap[k] = { status: 'known', value: v, sources: [] };
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
