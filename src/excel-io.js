// V1 解析 与 V2 整合导出
// V1: 把上传的 xlsx 解析为 customers[]，每个 customer 是 { fieldKey: value } 对象，未填字段为空字符串
// V2: 多客户行合并为总表；冲突字段单元格红底 + 用英文分号(;)罗列；补全字段含 来源 备注列

import ExcelJS from 'exceljs';
import { FIELDS, EXCEL_COLUMN_LABELS, mapHeadersToKeys, NUMERIC_LIKE_FIELDS } from './field-spec.js';

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

  const keys = mapHeadersToKeys(headers);

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

  // ===== Sheet 1: 客户调研总表 =====
  const ws = wb.addWorksheet('客户调研总表', { views: [{ state: 'frozen', xSplit: 1, ySplit: 1 }] });

  // 表头：与 V1 同顺序
  ws.addRow(EXCEL_COLUMN_LABELS);
  const headerRow = ws.getRow(1);
  headerRow.font = { bold: true, color: { argb: 'FF333333' } };
  headerRow.fill = HEADER_FILL;
  headerRow.alignment = { vertical: 'middle', horizontal: 'left' };
  headerRow.height = 22;

  for (const cust of customers) {
    const rowVals = FIELDS.map(f => {
      const r = cust.fields?.[f.key];
      if (!r) return '';
      if (r.status === 'conflict' && Array.isArray(r.values)) return r.values.filter(Boolean).join('; ');
      return r.value ?? '';
    });
    const row = ws.addRow(rowVals);
    row.alignment = { vertical: 'top', wrapText: true };

    // 染色：冲突红底、补充绿底
    FIELDS.forEach((f, i) => {
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
  }

  // 列宽
  EXCEL_COLUMN_LABELS.forEach((label, i) => {
    ws.getColumn(i + 1).width = Math.min(Math.max(label.length * 2 + 2, 14), 36);
  });

  // ===== Sheet 2: 来源回标 =====
  const ws2 = wb.addWorksheet('字段来源', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws2.addRow(['客户名称', '字段', '调研值', '状态', '来源 URL', '来源标题', '佐证摘录']);
  ws2.getRow(1).font = { bold: true };
  ws2.getRow(1).fill = HEADER_FILL;
  for (const cust of customers) {
    for (const f of FIELDS) {
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
 * 字段冲突判定：把已知值 vs 调研值/或两个调研值做粗对比
 * 返回 'agree' | 'conflict' | 'unknown'
 */
export function detectConflict(fieldKey, valA, valB) {
  if (!valA || !valB) return 'unknown';
  const a = String(valA).trim();
  const b = String(valB).trim();
  if (a === b) return 'agree';

  if (NUMERIC_LIKE_FIELDS.has(fieldKey)) {
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
