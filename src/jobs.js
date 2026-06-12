// 任务调度：用 p-limit 控制并发，按字段调用 researchField 并把结果落 db.
import pLimit from 'p-limit';
import { researchField, DEFAULT_MODEL } from './researcher.js';
import { FIELDS, NO_RESEARCH_FIELDS } from './field-spec.js';
import * as db from './db.js';

const FIELD_CONCURRENCY = parseInt(process.env.FIELD_CONCURRENCY || '4', 10);
const LABEL_OF = Object.fromEntries(FIELDS.map(f => [f.key, f.label]));

/**
 * 启动一个调研任务（异步执行；调用方拿 jobId 后轮询）
 * @param {object} args
 * @param {string[]} [args.customer_ids] - 默认全部客户
 * @param {string[]} [args.fields]       - 默认全部 32 字段（去掉 NO_RESEARCH_FIELDS）
 * @param {string}   [args.model]        - claude-opus-4-8 / claude-sonnet-4-6 / ...
 */
export function startResearchJob({ customer_ids, fields, model } = {}) {
  const customers = (customer_ids?.length
    ? customer_ids.map(id => db.getCustomer(id)).filter(Boolean)
    : db.listCustomers()
  );
  if (customers.length === 0) throw new Error('没有可调研的客户');

  const targetFields = (fields && fields.length ? fields : FIELDS.map(f => f.key))
    .filter(k => !NO_RESEARCH_FIELDS.has(k));

  const job = db.createJob({
    model: model || DEFAULT_MODEL,
    customer_ids: customers.map(c => c.id),
    fields: targetFields,
    status: 'running',
    progress: { done: 0, total: customers.length * targetFields.length },
    steps: [],
  });

  // 异步执行（不 await）
  runJob(job.id, customers, targetFields, model || DEFAULT_MODEL).catch(err => {
    db.updateJob(job.id, { status: 'failed', error: String(err?.message || err), finished_at: Date.now() });
  });

  return job;
}

async function runJob(jobId, customers, fields, model) {
  const limit = pLimit(FIELD_CONCURRENCY);
  const total = customers.length * fields.length;
  const multi = customers.length > 1;
  const steps = [];
  let done = 0;

  const tasks = [];
  for (const customer of customers) {
    for (const field of fields) {
      tasks.push(limit(async () => {
        let stepStatus = 'unknown', stepValue = '';
        try {
          const { result, sources } = await researchField({ customer, fieldKey: field, model });
          db.saveResult({ job_id: jobId, customer_id: customer.id, field, ...result }, sources);
          stepStatus = result.status || 'unknown';
          stepValue = result.status === 'conflict'
            ? (result.values || []).filter(Boolean).join(' / ')
            : (result.value || '');
        } catch (e) {
          db.saveResult({
            job_id: jobId, customer_id: customer.id, field,
            status: 'unknown', reason: '执行异常：' + (e?.message || e), model,
          }, []);
          stepStatus = 'error';
        } finally {
          done += 1;
          steps.push({
            label: (multi ? customer.customer_name + ' · ' : '') + (LABEL_OF[field] || field),
            status: stepStatus,
            value: String(stepValue || '').replace(/\s+/g, ' ').slice(0, 60),
          });
          // 每步都写：并发 4 + 每步是一次 LLM 调用，写入频率可控
          db.updateJob(jobId, { progress: { done, total }, steps: steps.slice(-80) });
        }
      }));
    }
  }
  await Promise.all(tasks);
  db.updateJob(jobId, {
    status: 'done',
    progress: { done: total, total },
    steps: steps.slice(-80),
    finished_at: Date.now(),
  });
}
