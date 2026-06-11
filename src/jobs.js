// 任务调度：用 p-limit 控制并发，按字段调用 researchField 并把结果落 db.
import pLimit from 'p-limit';
import { researchField, DEFAULT_MODEL } from './researcher.js';
import { FIELDS, NO_RESEARCH_FIELDS } from './field-spec.js';
import * as db from './db.js';

const FIELD_CONCURRENCY = parseInt(process.env.FIELD_CONCURRENCY || '4', 10);

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
    log: [],
  });

  // 异步执行（不 await）
  runJob(job.id, customers, targetFields, model || DEFAULT_MODEL).catch(err => {
    db.updateJob(job.id, { status: 'failed', error: String(err?.message || err), finished_at: Date.now() });
  });

  return job;
}

async function runJob(jobId, customers, fields, model) {
  const limit = pLimit(FIELD_CONCURRENCY);
  let done = 0;

  const tasks = [];
  for (const customer of customers) {
    for (const field of fields) {
      tasks.push(limit(async () => {
        try {
          const { result, sources } = await researchField({ customer, fieldKey: field, model });
          db.saveResult({
            job_id: jobId,
            customer_id: customer.id,
            field,
            ...result,
          }, sources);
        } catch (e) {
          db.saveResult({
            job_id: jobId,
            customer_id: customer.id,
            field,
            status: 'unknown',
            reason: '执行异常：' + (e?.message || e),
            model,
          }, []);
        } finally {
          done += 1;
          // 每 5 步落一次进度（少写 db）
          if (done % 5 === 0 || done === customers.length * fields.length) {
            db.updateJob(jobId, { progress: { done, total: customers.length * fields.length } });
          }
        }
      }));
    }
  }
  await Promise.all(tasks);
  db.updateJob(jobId, {
    status: 'done',
    progress: { done: customers.length * fields.length, total: customers.length * fields.length },
    finished_at: Date.now(),
  });
}
