// V1 解析 与 V2 整合导出
// V1: 把上传的 xlsx 解析为 customers[]，每个 customer 是 { fieldKey: value } 对象，未填字段为空字符串
// V2: 多客户行合并为总表；冲突字段单元格红底 + 用英文分号(;)罗列；补全字段含 来源 备注列

import ExcelJS from 'exceljs';
import { mapHeadersToKeys } from './field-spec.js';
import { getActiveFields, getExcelLabels, isNumericLike } from './fields.js';

const RED_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFCE4E4' } };
const RED_BORDER = { style: 'thin', color: { argb: 'FFF53F3F' } };
const GREEN_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE6F7EA' } };
const HEADER_FILL = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F7FA' } };

/**
 * 读 V1.xlsx：返回 { headers, rows, customers }
 * customers: [{ key1: val1, key2: val2, ... }] —— key 来自 field-spec 的英文 key
 */
export async function parseV1(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Excel 中没有可读工作表');

  // 第 1 行表头
  const headerRow = ws.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: false }, (cell) => {
    headers.push(String(cell.value ?? '').trim());
  });
  if (headers.length === 0) throw new Error('表头为空');

  const keys = mapHeadersToKeys(headers, getActiveFields());

  const customers = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!row.hasValues) continue;
    const obj = {};
    for (let c = 0; c < keys.length; c++) {
      const cell = row.getCell(c + 1);
      let v = cell.value;
      if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map(t => t.text).join('');
      if (v && typeof v === 'object' && 'text' in v) v = v.text;
      obj[keys[c]] = v == null ? '' : String(v).trim();
    }
    if (!obj.customer_name) continue;  // 跳过完全空行
    customers.push(obj);
  }

  return { headers, rowCount: customers.length, fieldCount: headers.length, customers };
}

/**
 * 写 V2.xlsx 整合总表
 * @param {string} filePath
 * @param {Array} customers - 已合并调研结果的客户数组
 *   customers[i] = { customer_name, fields: { fieldKey: { value, status: 'known'|'filled'|'conflict', sources: [...] , values?: [v1,v2] } } }
 */
export async function exportV2(filePath, customers) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '商务通客户智能调研系统';
  wb.created = new Date();

  const ACTIVE_FIELDS = getActiveFields();   // ★ 动态字段（随字段管理实时变化）

  // ===== Sheet 1: 客户调研总表 =====
  const ws = wb.addWorksheet('客户调研总表', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });

  // 表头：当前启用字段 label 同顺序 + 末尾追加 "模型一致性" 列
  const HEADERS = [...getExcelLabels(), '模型一致性'];
  ws.addRow(HEADERS);
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF333333' } };
  headerRow.fill = HEADER_FILL;
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 22;

  for (const cust of customers) {
    const rowVals = ACTIVE_FIELDS.map(f => {
      const r = cust.fields?.[f.key];
      if (!r) return '';
      if (r.status === 'conflict' && Array.isArray(r.values)) return r.values.filter(Boolean).join('; ');
      return r.value ?? '';
    });
    // 末尾追加 "模型一致性" 摘要：取所有有 model_summary 的字段汇总成一段（前 5 个最有信息量的）
    const conflictFields = ACTIVE_FIELDS.filter(f => cust.fields?.[f.key]?.status === 'conflict')
      .map(f => f.label).slice(0, 5);
    const summary = conflictFields.length
      ? `冲突 ${conflictFields.length} 项: ${conflictFields.join('、')}`
      : '所有字段一致';
    rowVals.push(summary);

    const row = ws.addRow(rowVals);
    row.alignment = { vertical: 'top', wrapText: true };

    // 染色：冲突红底、补充绿底
    ACTIVE_FIELDS.forEach((f, i) => {
      const r = cust.fields?.[f.key];
      if (!r) return;
      const cell = row.getCell(i + 1);
      if (r.status === 'conflict') {
        cell.fill = RED_FILL;
        cell.border = { top: RED_BORDER, left: RED_BORDER, bottom: RED_BORDER, right: RED_BORDER };
      } else if (r.status === 'filled') {
        cell.fill = GREEN_FILL;
      }
    });
    // 模型一致性列染色：有冲突时也红
    if (conflictFields.length) {
      const c = row.getCell(HEADERS.length);
      c.fill = RED_FILL;
      c.font = { color: { argb: 'FFC2190C' }, bold: true };
    }
  }

  // 列宽
  HEADERS.forEach((label, i) => {
    ws.getColumn(i + 1).width = Math.min(Math.max(label.length * 2 + 2, 14), 36);
  });

  // ===== Sheet 2: 来源回标 =====
  const ws2 = wb.addWorksheet('字段来源', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws2.addRow(['客户名称', '字段', '调研值', '状态', '来源 URL', '来源标题', '佐证摘录']);
  ws2.getRow(1).font = { bold: true };
  ws2.getRow(1).fill = HEADER_FILL;
  for (const cust of customers) {
    for (const f of ACTIVE_FIELDS) {
      const r = cust.fields?.[f.key];
      if (!r || !r.sources?.length) continue;
      for (const src of r.sources) {
        ws2.addRow([
          cust.customer_name || '',
          f.label,
          r.status === 'conflict' ? (r.values || []).join(' | ') : (r.value || ''),
          r.status,
          src.url || '',
          src.title || '',
          src.evidence || ''
        ]);
      }
    }
  }
  ws2.columns.forEach(col => { col.width = Math.min(Math.max(col.header?.length * 2 || 14, 14), 60); });

  await wb.xlsx.writeFile(filePath);
  return filePath;
}

/**
 * 生成批量调研模板：表头 = 当前启用字段的中文名，字段解释作为表头单元格批注（鼠标悬停可见）。
 * 不写第二行示例，避免被 parseV1 当成客户数据解析。用户填好后通过 /api/upload 上传即可批量调研。
 */
export async function buildTemplate(filePath) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '商务通客户智能调研系统';
  const ws = wb.addWorksheet('客户清单', { views: [{ state: 'frozen', ySplit: 1 }] });

  const activeFields = getActiveFields();
  const labels = activeFields.map(f => f.label);
  ws.addRow(labels);
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF333333' } };
  headerRow.fill = HEADER_FILL;
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 22;

  // 字段解释 + 来源说明作为表头单元格批注（不污染数据区）
  activeFields.forEach((f, i) => {
    const note = [f.hint, f.source_note].filter(Boolean).join('\n');
    if (note) headerRow.getCell(i + 1).note = note;
    ws.getColumn(i + 1).width = Math.min(Math.max(f.label.length * 2 + 2, 14), 36);
  });

  await wb.xlsx.writeFile(filePath);
  return filePath;
}

/** 字段管理列定义（导出/导入共用） */
const FIELD_DEF_COLUMNS = [
  { header: '中文名称', key: 'label' },
  { header: '字段解释', key: 'hint' },
  { header: '来源说明', key: 'source_note' },
  { header: '分组', key: 'group' },
  { header: '启用(是/否)', key: 'enabled' },
];

/** 分组 key ↔ 中文名（导出用中文，导入转回 key；自定义中文分组名原样保留） */
const GROUP_LABELS = {
  basic: '基本信息', app: 'APP', product: '产品', biz: '业务规模', data: '数据',
  collection: '催收', people: '人员', goal: '目标', meta: '其他', custom: '自定义',
};
const GROUP_KEYS = Object.fromEntries(Object.entries(GROUP_LABELS).map(([k, v]) => [v, k]));
const groupToLabel = (g) => GROUP_LABELS[g] || g || '自定义';
const labelToGroup = (s) => GROUP_KEYS[String(s).trim()] || String(s).trim();

/** 导出字段定义为 xlsx（供批量编辑后再导入） */
export async function exportFieldDefs(filePath, defs) {
  const wb = new ExcelJS.Workbook();
  wb.creator = '商务通客户智能调研系统';
  const ws = wb.addWorksheet('字段定义', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.addRow(FIELD_DEF_COLUMNS.map(c => c.header));
  const hr = ws.getRow(1);
  hr.font = { bold: true, color: { argb: 'FF333333' } };
  hr.fill = HEADER_FILL;
  hr.height = 22;
  const yn = (b) => (b ? '是' : '否');
  for (const f of defs) {
    ws.addRow([
      f.label || '', f.hint || '', f.source_note || '',
      groupToLabel(f.group), yn(f.enabled !== false),
    ]);
  }
  FIELD_DEF_COLUMNS.forEach((c, i) => {
    ws.getColumn(i + 1).width = Math.min(Math.max(c.header.length * 2, 14), 40);
  });
  await wb.xlsx.writeFile(filePath);
  return filePath;
}

/** 解析导入的字段定义 xlsx，返回规范化的行对象数组（不落库，由调用方决定 upsert）。
 *  无 key 列：导入时按「中文名称」匹配（同名更新，否则新建）。 */
export async function parseFieldDefs(filePath) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('Excel 中没有可读工作表');
  const cellText = (cell) => {
    let v = cell.value;
    if (v && typeof v === 'object' && 'richText' in v) v = v.richText.map(t => t.text).join('');
    if (v && typeof v === 'object' && 'text' in v) v = v.text;
    return v == null ? '' : String(v).trim();
  };
  const isYes = (s) => /^(是|y|yes|true|1|✓)$/i.test(String(s).trim());
  const rows = [];
  for (let r = 2; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    if (!row.hasValues) continue;
    const label = cellText(row.getCell(1));
    if (!label) continue; // 中文名称必填，空行跳过
    rows.push({
      label,
      hint: cellText(row.getCell(2)),
      source_note: cellText(row.getCell(3)),
      group: labelToGroup(cellText(row.getCell(4))) || 'custom',
      enabled: cellText(row.getCell(5)) === '' ? true : isYes(cellText(row.getCell(5))),
    });
  }
  return rows;
}

/**
 * 字段冲突判定：把已知值 vs 调研值/或两个调研值做粗对比
 * 返回 'agree' | 'conflict' | 'unknown'
 */
export function detectConflict(fieldKey, valA, valB) {
  if (!valA || !valB) return 'unknown';
  const a = String(valA).trim();
  const b = String(valB).trim();
  if (a === b) return 'agree';

  if (isNumericLike(fieldKey)) {
    const na = parseFirstNumber(a);
    const nb = parseFirstNumber(b);
    if (na != null && nb != null) {
      const denom = Math.max(Math.abs(na), Math.abs(nb), 1e-6);
      const diff = Math.abs(na - nb) / denom;
      return diff <= 0.2 ? 'agree' : 'conflict';
    }
  }
  // 文本：相似度（简化为 Jaccard on bigrams）
  const sim = jaccardSim(a, b);
  return sim >= 0.6 ? 'agree' : 'conflict';
}

function parseFirstNumber(s) {
  // 提取首个数值（支持 "约 120 万" "20%" "1-3万" 等）
  const m = String(s).match(/-?\d+(?:[\.,]\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0].replace(',', '.'));
  if (/万/.test(s)) n *= 10000;
  if (/亿/.test(s)) n *= 1e8;
  if (/%/.test(s)) n /= 100;
  return n;
}

function bigrams(s) {
  const out = new Set();
  const t = s.toLowerCase().replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
function jaccardSim(a, b) {
  const A = bigrams(a), B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}
