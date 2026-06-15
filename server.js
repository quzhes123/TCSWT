// Fastify 服务入口
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { nanoid } from 'nanoid';

import { parseV1, exportV2 } from './src/excel-io.js';
import * as db from './src/db.js';
import { startResearchJob } from './src/jobs.js';
import { FIELDS, FIELD_BY_KEY } from './src/field-spec.js';
import { SEARCH_ENABLED, PROVIDER as SEARCH_PROVIDER } from './src/serp.js';
import { reloadRegistry } from './src/models/registry.js';
import { AnthropicDriver } from './src/models/driver-anthropic.js';
import { OpenAIDriver } from './src/models/driver-openai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const PORT = parseInt(process.env.PORT || '8787', 10);
const MAX_BATCH = parseInt(process.env.MAX_CUSTOMERS_PER_BATCH || '50', 10);

// ============ 鉴权配置 ============
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin123';
const SESSION_SECRET = process.env.SESSION_SECRET || 'tcswt-default-session-secret-please-override';
const COOKIE_NAME = 'tcswt_session';
const SESSION_TTL_DEFAULT = 12 * 60 * 60; // 12h
const SESSION_TTL_REMEMBER = 7 * 24 * 60 * 60; // 7d

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}
function signSession(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  return `${body}.${sig}`;
}
function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const idx = token.lastIndexOf('.');
  if (idx < 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = b64url(crypto.createHmac('sha256', SESSION_SECRET).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try { payload = JSON.parse(b64urlDecode(body).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.exp !== 'number' || payload.exp * 1000 < Date.now()) return null;
  return payload;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
function getSession(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  return verifySession(cookies[COOKIE_NAME]);
}
function issueCookie(reply, payload, ttlSec) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const token = signSession({ ...payload, exp });
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${ttlSec}`,
    'Secure',
  ];
  reply.header('Set-Cookie', parts.join('; '));
}
function clearCookie(reply) {
  reply.header('Set-Cookie', `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Secure`);
}

// 公共路径白名单（不需要登录）
const PUBLIC_PATHS = new Set(['/login.html', '/api/login', '/api/logout', '/favicon.ico']);
function isPublicAsset(url) {
  // 允许登录页引用的本地静态资源（当前没有，但保留扩展位置）
  return /\.(svg|png|jpe?g|webp|gif|ico|woff2?|css|map)$/i.test(url);
}

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 30 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });

// ============ 鉴权前置钩子（必须在静态插件之前注册以拦截 / 与 /index.html）============
app.addHook('onRequest', async (req, reply) => {
  const rawUrl = req.url || '/';
  const urlPath = rawUrl.split('?')[0];
  if (PUBLIC_PATHS.has(urlPath) || isPublicAsset(urlPath)) return;
  const session = getSession(req);
  if (session) {
    req.user = session;
    return;
  }
  if (urlPath.startsWith('/api/')) {
    return reply.code(401).send({ error: '未登录或会话已过期', code: 'UNAUTHENTICATED' });
  }
  // 页面跳转到登录页，并保留 next
  const next = encodeURIComponent(rawUrl);
  return reply.code(302).header('Location', `/login.html?next=${next}`).send();
});

await app.register(staticPlugin, { root: path.join(__dirname, 'public'), prefix: '/' });

// ============ 鉴权 API ============
app.post('/api/login', async (req, reply) => {
  const { username, password, remember } = req.body || {};
  const u = String(username || '').trim();
  const p = String(password || '');
  if (!u || !p) return reply.code(400).send({ ok: false, error: '请输入用户名和密码' });
  // 等长比较防止时序攻击
  const okUser = u.length === ADMIN_USER.length &&
    crypto.timingSafeEqual(Buffer.from(u.padEnd(ADMIN_USER.length)), Buffer.from(ADMIN_USER.padEnd(ADMIN_USER.length)));
  const okPass = p.length === ADMIN_PASS.length &&
    crypto.timingSafeEqual(Buffer.from(p.padEnd(ADMIN_PASS.length)), Buffer.from(ADMIN_PASS.padEnd(ADMIN_PASS.length)));
  if (!okUser || !okPass) {
    await new Promise(r => setTimeout(r, 350)); // 轻量节流
    return reply.code(401).send({ ok: false, error: '用户名或密码错误' });
  }
  const ttl = remember ? SESSION_TTL_REMEMBER : SESSION_TTL_DEFAULT;
  issueCookie(reply, { u }, ttl);
  return { ok: true, user: { name: u } };
});

app.post('/api/logout', async (req, reply) => {
  clearCookie(reply);
  return { ok: true };
});

app.get('/api/me', async (req, reply) => {
  // 已经过 onRequest 鉴权，这里 req.user 一定存在
  return { ok: true, user: { name: req.user?.u || ADMIN_USER } };
});

// ============ API: 元信息 ============
app.get('/api/fields', async () => ({ fields: FIELDS }));

app.get('/api/health', async () => ({
  ok: true,
  model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
  base_url: process.env.ANTHROPIC_BASE_URL || '(default)',
  has_token: !!(process.env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY),
  search: { enabled: SEARCH_ENABLED, provider: SEARCH_PROVIDER },
}));

// ============ API: 上传 V1.xlsx ============
app.post('/api/upload', async (req, reply) => {
  const part = await req.file();
  if (!part) return reply.code(400).send({ error: '未收到文件' });
  const ext = (part.filename || '').toLowerCase().endsWith('.xlsx') ? '.xlsx' : '.xlsx';
  const savePath = path.join(UPLOAD_DIR, `${Date.now()}-${nanoid(6)}${ext}`);
  await new Promise((res, rej) => {
    const ws = fs.createWriteStream(savePath);
    part.file.pipe(ws);
    ws.on('finish', res);
    ws.on('error', rej);
  });

  const parsed = await parseV1(savePath);
  if (parsed.customers.length > MAX_BATCH) {
    return reply.code(400).send({ error: `单批最多 ${MAX_BATCH} 条客户，当前 ${parsed.customers.length} 条，请分批上传` });
  }

  // 写库（覆盖：MVP 一批清一次）
  const customers = parsed.customers.map(c => ({
    customer_name: c.customer_name,
    region: c.region || '',
    customer_level: c.customer_level || '',
    business_line: c.business_line || '',
    product_type: c.product_type || '',
    raw_known: c,           // 完整 32 字段已知值
  }));
  const saved = db.replaceCustomers(customers);

  return {
    ok: true,
    file: path.basename(savePath),
    customer_count: saved.length,
    field_count: parsed.fieldCount,
    customers: saved,
  };
});

// ============ API: 客户列表 / 详情 / 看板 ============
app.get('/api/customers', async (req) => {
  const { q, level, region } = req.query || {};
  let list = db.listCustomers();
  if (level) list = list.filter(c => c.customer_level === level);
  if (region) list = list.filter(c => c.region === region);
  if (q) {
    const kw = String(q).toLowerCase();
    list = list.filter(c => Object.values(c.raw_known || {}).some(v => String(v || '').toLowerCase().includes(kw)));
  }
  // 顺带把每个客户的调研完整度算上
  const allResults = db.listResults();
  return list.map(c => {
    const rs = allResults.filter(r => r.customer_id === c.id);
    const nKnown = Object.entries(c.raw_known || {}).filter(([, v]) => v && String(v).trim()).length;
    const nFilled = rs.filter(r => r.status === 'filled' || r.status === 'agree').length;
    const nConflict = rs.filter(r => r.status === 'conflict').length;
    const completeness = Math.round(((nKnown + nFilled) / FIELDS.length) * 100);
    return { ...c, _stat: { nKnown, nFilled, nConflict, completeness } };
  });
});

app.get('/api/customers/:id', async (req, reply) => {
  const c = db.getCustomer(req.params.id);
  if (!c) return reply.code(404).send({ error: '客户不存在' });
  return c;
});

app.get('/api/customers/:id/report', async (req, reply) => {
  const r = db.buildCustomerReport(req.params.id);
  if (!r) return reply.code(404).send({ error: '客户不存在' });
  return r;
});

app.get('/api/stats', async () => db.computeStats());

// ============ API: 调研任务 ============
app.post('/api/research', async (req, reply) => {
  const { customer_ids, fields, models, custom_fields } = req.body || {};
  try {
    const job = startResearchJob({ customer_ids, fields, models, custom_fields });
    return { ok: true, job };
  } catch (e) {
    return reply.code(400).send({ error: String(e?.message || e) });
  }
});

// ============ API: 按指定内容快调（公司名 / APP 名 / 展业区域，三者至少一项）============
app.post('/api/research/by-name', async (req, reply) => {
  const { name, customer_name_input, app_name, region, fields, models, custom_fields } = req.body || {};
  const fallbackName = String(name || '').trim();
  const realCompany = String(customer_name_input || '').trim();   // 用户实际输入的公司名（可能为空）
  const appNameTrim = String(app_name || '').trim();
  const regionTrim = String(region || '').trim();
  // 三选一校验：必须至少有一项
  if (!fallbackName && !realCompany && !appNameTrim && !regionTrim) {
    return reply.code(400).send({ error: '请至少填写公司名称 / APP 名称 / 展业区域 中的一项' });
  }
  // 客户记录的展示名:优先公司名 → 否则用 fallback (前端构造的"APP @ 区域"格式)
  const customer_name = realCompany || fallbackName || appNameTrim || regionTrim;
  try {
    // raw_known 只装"用户实际填写的字段",兜底名不进 raw_known(否则会被当已知值参与合并冲突)
    const raw_known = {};
    if (realCompany) raw_known.customer_name = realCompany;
    if (appNameTrim) raw_known.app_name = appNameTrim;
    if (regionTrim)  raw_known.region   = regionTrim;
    const c = db.addCustomer({
      customer_name,                                  // 客户记录显示名(可能是兜底)
      ...(regionTrim ? { region: regionTrim } : {}),
      raw_known,
    });
    const job = startResearchJob({ customer_ids: [c.id], fields, models, custom_fields });
    return { ok: true, customer: c, job };
  } catch (e) {
    return reply.code(400).send({ error: String(e?.message || e) });
  }
});

app.get('/api/jobs/:id', async (req, reply) => {
  const j = db.getJob(req.params.id);
  if (!j) return reply.code(404).send({ error: '任务不存在' });
  return j;
});

app.get('/api/jobs', async () => db.listJobs());

// ============ API: 批量导出 V2 ============
// ?ids=id1,id2  → 仅导这些客户；不传 → 导出全部
app.get('/api/export/v2.xlsx', async (req, reply) => {
  const idsParam = (req.query?.ids || '').toString().trim();
  const ids = idsParam ? idsParam.split(',').map(s => s.trim()).filter(Boolean) : null;
  const list = ids ? ids.map(id => db.getCustomer(id)).filter(Boolean) : db.listCustomers();
  if (list.length === 0) return reply.code(400).send({ error: ids ? '所选客户不存在' : '暂无客户可导出' });
  const customers = list.map(c => db.buildCustomerReport(c.id));
  const out = path.join(EXPORT_DIR, `V2-${Date.now()}.xlsx`);
  await exportV2(out, customers);
  // ASCII 文件名 + RFC 5987 中文文件名（区分全量/选中）
  const ts = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const ascii = `V2-${ts}.xlsx`;
  const zh = ids ? `批量调研报告-${list.length}个客户-${ts}.xlsx` : `客户调研总表-${ts}.xlsx`;
  reply.header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(zh)}`);
  reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return fs.createReadStream(out);
});

// ============ API: 导出单客户报告 ============
app.get('/api/customers/:id/export.xlsx', async (req, reply) => {
  const report = db.buildCustomerReport(req.params.id);
  if (!report) return reply.code(404).send({ error: '客户不存在' });
  const safeName = String(report.customer?.customer_name || 'customer').replace(/[\\\/:*?"<>|]/g, '_').slice(0, 40);
  const out = path.join(EXPORT_DIR, `report-${safeName}-${Date.now()}.xlsx`);
  await exportV2(out, [report]);
  // 用 RFC 5987 编码非 ASCII 文件名（含中文公司名时浏览器才能正确显示）
  const ascii = 'report.xlsx';
  const encoded = encodeURIComponent(`${safeName}-调研报告.xlsx`);
  reply.header('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
  reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return fs.createReadStream(out);
});

// ============ API: 模型配置管理 ============
function pickModelInput(body) {
  // 显式列字段防止前端塞奇怪东西到 db
  const out = {};
  ['name','identifier','provider','version','description','api_url','auth_type',
   'api_key','custom_headers','timeout','max_retries','concurrency','request_template','response_path','enabled']
   .forEach(k => { if (body && k in body) out[k] = body[k]; });
  return out;
}

app.get('/api/models', async (req) => {
  const enabledOnly = req.query?.enabled === '1' || req.query?.enabled === 'true';
  return db.listModels({ enabledOnly });
});

app.get('/api/models/:id', async (req, reply) => {
  const m = db.getModel(req.params.id);
  if (!m) return reply.code(404).send({ error: '模型不存在' });
  return m;
});

app.post('/api/models', async (req, reply) => {
  const input = pickModelInput(req.body);
  if (!input.name || !input.api_url) return reply.code(400).send({ error: '名称和 API URL 必填' });
  const m = db.createModel(input);
  reloadRegistry();
  return { ok: true, model: m };
});

app.put('/api/models/:id', async (req, reply) => {
  const input = pickModelInput(req.body);
  const m = db.updateModel(req.params.id, input);
  if (!m) return reply.code(404).send({ error: '模型不存在' });
  reloadRegistry();
  return { ok: true, model: m };
});

app.delete('/api/models/:id', async (req, reply) => {
  const ok = db.deleteModel(req.params.id);
  if (!ok) return reply.code(404).send({ error: '模型不存在' });
  reloadRegistry();
  return { ok: true };
});

app.post('/api/models/:id/toggle', async (req, reply) => {
  const m = db.getModel(req.params.id);
  if (!m) return reply.code(404).send({ error: '模型不存在' });
  const updated = db.updateModel(req.params.id, { enabled: !m.enabled });
  reloadRegistry();
  return { ok: true, model: updated };
});

// 连通性测试：用 driver.ping() 探活，记录到 last_test_*
app.post('/api/models/:id/test', async (req, reply) => {
  const full = db.getModelWithSecret(req.params.id);
  if (!full) return reply.code(404).send({ error: '模型不存在' });
  const Cls = full.provider === 'anthropic' ? AnthropicDriver : OpenAIDriver;
  const driver = new Cls(full);
  const r = await driver.ping();
  db.recordModelTest(req.params.id, r.ok, r.error || '');
  return { ok: r.ok, latencyMs: r.latencyMs, sample: r.sample || '', error: r.error || '' };
});

// ============ 启动 ============
try {
  db.autoMigrateModels();  // 首次启动从 .env 迁移 Anthropic 配置
  reloadRegistry();         // 加载已启用的模型驱动
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\n  ✅ 商务通调研系统已启动：http://localhost:${PORT}`);
  console.log(`     模型：${process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'}`);
  console.log(`     网关：${process.env.ANTHROPIC_BASE_URL || '(直连 api.anthropic.com)'}`);
} catch (e) {
  console.error('启动失败：', e);
  process.exit(1);
}
