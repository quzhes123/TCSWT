// 任务调度：用 p-limit 控制并发，按字段 fan-out 多模型调用 researchField 并合并结果落 db.
import pLimit from 'p-limit';
import { researchField } from './researcher.js';
import { FIELDS, NO_RESEARCH_FIELDS } from './field-spec.js';
import * as db from './db.js';
import { getDriver } from './models/registry.js';
import { mergeMultiModel } from './merger.js';

const FIELD_CONCURRENCY = parseInt(process.env.FIELD_CONCURRENCY || '4', 10);
const LABEL_OF = Object.fromEntries(FIELDS.map(f => [f.key, f.label]));

/**
 * 启动一个调研任务（异步执行；调用方拿 jobId 后轮询）
 * @param {object} args
 * @param {string[]} [args.customer_ids] - 默认全部客户
 * @param {string[]} [args.fields]       - 预定义字段 key 数组（默认全部 32 字段去掉 NO_RESEARCH_FIELDS）
 * @param {Array<{label,hint?}>} [args.custom_fields] - 自定义临时字段
 * @param {string[]} [args.models]       - 模型 id 数组（多模型并行）；缺省时取全部已启用模型
 */
export function startResearchJob({ customer_ids, fields, models, custom_fields } = {}) {
  const customers = (customer_ids?.length
    ? customer_ids.map(id => db.getCustomer(id)).filter(Boolean)
    : db.listCustomers()
  );
  if (customers.length === 0) throw new Error('没有可调研的客户');

  // 预定义字段
  const targetFields = (fields && fields.length ? fields : FIELDS.map(f => f.key))
    .filter(k => !NO_RESEARCH_FIELDS.has(k));

  // 自定义字段：清洗 + 去重
  const customSpecs = [];
  const seen = new Set([...targetFields, ...FIELDS.map(f => f.key)]);
  for (const cf of (custom_fields || [])) {
    const label = String(cf?.label || '').trim();
    if (!label) continue;
    const key = 'custom_' + Buffer.from(label, 'utf8').toString('hex').slice(0, 16);
    if (seen.has(key)) continue;
    seen.add(key);
    customSpecs.push({
      key, label, group: 'custom',
      hint: String(cf?.hint || '').trim() || undefined,
    });
  }
  const customKeys = customSpecs.map(s => s.key);
  const customSpecMap = Object.fromEntries(customSpecs.map(s => [s.key, s]));
  const allFields = [...targetFields, ...customKeys];
  if (allFields.length === 0) throw new Error('没有可调研的字段');

  // 模型列表：前端传 models 数组（可多选），或默认取全部已启用
  let modelIds = models && models.length ? models : db.listModels({ enabledOnly: true }).map(m => m.id);
  if (!modelIds.length) throw new Error('没有已启用的模型，请到「模型管理」配置');

  const job = db.createJob({
    models: modelIds,
    customer_ids: customers.map(c => c.id),
    fields: allFields,
    custom_specs: customSpecs,
    status: 'running',
    progress: { done: 0, total: customers.length * allFields.length },
    steps: [],
  });

  runJob(job.id, customers, allFields, modelIds, customSpecMap).catch(err => {
    db.updateJob(job.id, { status: 'failed', error: String(err?.message || err), finished_at: Date.now() });
  });

  return job;
}

async function runJob(jobId, customers, fields, modelIds, customSpecMap = {}) {
  const limit = pLimit(FIELD_CONCURRENCY);
  const total = customers.length * fields.length;
  const multi = customers.length > 1;
  const steps = [];
  let done = 0;

  const drivers = modelIds.map(id => getDriver(id)).filter(Boolean);
  if (!drivers.length) throw new Error('所选模型全部无效/未加载');

  const labelOf = (k) => customSpecMap[k]?.label || LABEL_OF[k] || k;

  const tasks = [];
  for (const customer of customers) {
    for (const field of fields) {
      tasks.push(limit(async () => {
        let stepStatus = 'unknown', stepValue = '';
        const customSpec = customSpecMap[field];   // 自定义字段时非空
        try {
          // fan-out：并发跨 N 个模型调研同一字段
          const rawResults = await Promise.all(
            drivers.map(async (driver) => {
              try {
                const { result, sources } = await researchField({ customer, fieldKey: field, spec: customSpec, driver });
                // 原始结果落库（中间产物，需求 §3.1）
                db.saveResult({ job_id: jobId, customer_id: customer.id, field, model: driver.id, ...result }, sources);
                return {
                  modelId: driver.id,
                  modelName: driver.displayName,
                  status: result.status || 'unknown',
                  value: result.value || '',
                  reason: result.reason || '',
                  confidence: result.confidence,
                  sources: sources || [],
                };
              } catch (e) {
                // 单个模型失败不阻塞其他模型
                db.saveResult({
                  job_id: jobId, customer_id: customer.id, field, model: driver.id,
                  status: 'unknown', reason: '执行异常：' + (e?.message || e),
                }, []);
                return { modelId: driver.id, modelName: driver.displayName, status: 'unknown', value: '', sources: [] };
              }
            })
          );

          // 合并多模型结果（已知值作为虚拟模型参与）
          const merged = mergeMultiModel({
            fieldKey: field,
            knownValue: customer.raw_known?.[field] || null,
            modelResults: rawResults,
          });

          // 合并结论落库（is_merged=true，关联原始 result ids）
          const rawIds = db.listResults({ job_id: jobId, customer_id: customer.id, field }).map(r => r.id);
          db.saveResult({
            job_id: jobId,
            customer_id: customer.id,
            field,
            model: null,          // 合并结论无单一 model
            is_merged: true,
            raw_result_ids: rawIds,
            status: merged.status,
            value: merged.value,
            values: merged.values || null,
            reason: merged.reason,
            model_summary: merged.model_summary,
            confidence: null,
          }, merged.sources || []);

          stepStatus = merged.status;
          stepValue = merged.status === 'conflict'
            ? (merged.values || []).filter(Boolean).join(' / ')
            : (merged.value || '');
        } catch (e) {
          // 整个字段失败（极少见，合并逻辑本身错）
          db.saveResult({
            job_id: jobId, customer_id: customer.id, field,
            status: 'unknown', reason: '合并失败：' + (e?.message || e),
          }, []);
          stepStatus = 'error';
        } finally {
          done += 1;
          steps.push({
            label: (multi ? customer.customer_name + ' · ' : '') + labelOf(field),
            status: stepStatus,
            value: String(stepValue || '').replace(/\s+/g, ' ').slice(0, 60),
          });
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

