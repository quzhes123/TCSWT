// 字段读取统一出口：从 db.field_defs 读取（字段管理维护的结果），带兜底。
// 取代各模块对 field-spec.js 静态 FIELDS / EXCEL_COLUMN_LABELS 的直接依赖，
// 使「字段管理」中的增删改启停能实时影响调研、导出、模板、报告完整度计算。
import * as db from './db.js';
import { FIELDS as SEED_FIELDS, NUMERIC_LIKE_FIELDS, NO_RESEARCH_FIELDS } from './field-spec.js';

/** 兜底：db 尚未迁移（理论上启动时已迁移）时回退到种子定义 */
function fallbackDefs() {
  return SEED_FIELDS.map((f, i) => ({
    key: f.key, label: f.label, group: f.group || 'meta',
    hint: f.hint || '',
    source_note: [
      f.sources?.primary?.length ? '优先来源：' + f.sources.primary.join('、') : '',
      f.sources?.fallback?.length ? '备选来源：' + f.sources.fallback.join('、') : '',
    ].filter(Boolean).join('；'),
    numeric: NUMERIC_LIKE_FIELDS.has(f.key),
    no_research: NO_RESEARCH_FIELDS.has(f.key),
    enabled: true, builtin: true, order: i,
  }));
}

/** 全部字段（含停用），字段管理页用 */
export function getAllFields() {
  const list = db.listFieldDefs();
  return list.length ? list : fallbackDefs();
}

/** 启用中的字段（按 order 排序）——调研、导出、模板、完整度都用这个 */
export function getActiveFields() {
  const list = db.listFieldDefs({ activeOnly: true });
  return list.length ? list : fallbackDefs();
}

/** 单字段定义（任意启停状态） */
export function getFieldByKey(key) {
  return getAllFields().find(f => f.key === key);
}

/** 导出 / 模板的表头标签（仅启用字段，按顺序） */
export function getExcelLabels() {
  return getActiveFields().map(f => f.label);
}

/** 数值型字段判定（冲突阈值用） */
export function isNumericLike(key) {
  const f = getFieldByKey(key);
  if (f) return !!f.numeric;
  return NUMERIC_LIKE_FIELDS.has(key); // 兜底
}

/** 不参与调研的字段 key 集合 */
export function getNoResearchKeys() {
  return new Set(getAllFields().filter(f => f.no_research).map(f => f.key));
}
