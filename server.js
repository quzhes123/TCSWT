// Fastify 服务入口
import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import { nanoid } from 'nanoid';

import { parseV1, exportV2 } from './src/excel-io.js';
import * as db from './src/db.js';
import { startResearchJob } from './src/jobs.js';
import { FIELDS, FIELD_BY_KEY } from './src/field-spec.js';
import { SEARCH_ENABLED, PROVIDER as SEARCH_PROVIDER } from './src/serp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(EXPORT_DIR, { recursive: true });

const PORT = parseInt(process.env.PORT || '8787', 10);
const MAX_BATCH = parseInt(process.env.MAX_CUSTOMERS_PER_BATCH || '50', 10);

const app = Fastify({ logger: { level: 'info' }, bodyLimit: 30 * 1024 * 1024 });
await app.register(multipart, { limits: { fileSize: 30 * 1024 * 1024 } });
await app.register(staticPlugin, { root: path.join(__dirname, 'public'), prefix: '/' });

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
  const { customer_ids, fields, model } = req.body || {};
  try {
    const job = startResearchJob({ customer_ids, fields, model });
    return { ok: true, job };
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

// ============ API: 导出 V2 ============
app.get('/api/export/v2.xlsx', async (req, reply) => {
  const customers = db.listCustomers().map(c => db.buildCustomerReport(c.id));
  const out = path.join(EXPORT_DIR, `V2-${Date.now()}.xlsx`);
  await exportV2(out, customers);
  reply.header('Content-Disposition', `attachment; filename="V2-${Date.now()}.xlsx"`);
  reply.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  return fs.createReadStream(out);
});

// ============ 启动 ============
try {
  await app.listen({ port: PORT, host: '0.0.0.0' });
  console.log(`\n  ✅ 商务通调研系统已启动：http://localhost:${PORT}`);
  console.log(`     模型：${process.env.ANTHROPIC_MODEL || 'claude-opus-4-8'}`);
  console.log(`     网关：${process.env.ANTHROPIC_BASE_URL || '(直连 api.anthropic.com)'}`);
} catch (e) {
  console.error('启动失败：', e);
  process.exit(1);
}
