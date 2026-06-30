// 端到端冒烟：用真实 表头V1.xlsx 验证解析 + V2 写出
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

import { parseV1, exportV2, detectConflict } from '../src/excel-io.js';
import { FIELDS, FIELD_BY_KEY } from '../src/field-spec.js';
import { getActiveFields } from '../src/fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const V1 = path.resolve(__dirname, '..', '..', '表头V1.xlsx');
const TMP_V2 = path.resolve(__dirname, '..', 'data', '_test_v2.xlsx');

test('field-spec: 32 字段、key 无重复', () => {
  assert.equal(FIELDS.length, 32);
  const keys = new Set(FIELDS.map(f => f.key));
  assert.equal(keys.size, FIELDS.length);
});

test('parseV1: 解析真实表头 V1.xlsx', async () => {
  assert.ok(fs.existsSync(V1), 'V1 文件存在');
  const r = await parseV1(V1);
  assert.ok(r.fieldCount >= 1, '识别到表头字段');
  assert.ok(r.customers.length >= 1, '至少 1 条客户');
  const c0 = r.customers[0];
  // 表头别名（客户名称→customer_name）应生效，客户名非空
  assert.ok(c0.customer_name && c0.customer_name.length > 0, '首行客户名称已解析');
});

test('detectConflict: 数值/文本/相同/未知', () => {
  assert.equal(detectConflict('bad_debt_rate', '约20%', '约15%'), 'conflict');     // 差 25%
  assert.equal(detectConflict('bad_debt_rate', '约18%', '约17%'), 'agree');         // 差 ~6%
  assert.equal(detectConflict('cust_total', '120万', '约120万'), 'agree');
  assert.equal(detectConflict('region', '墨西哥', '墨西哥'), 'agree');
  assert.equal(detectConflict('region', '墨西哥', '巴西'), 'conflict');
  assert.equal(detectConflict('region', '', '墨西哥'), 'unknown');
});

test('exportV2: 写 V2 总表，冲突字段红底', async () => {
  fs.mkdirSync(path.dirname(TMP_V2), { recursive: true });
  const customers = [
    {
      customer_name: '众米科技（微米）',
      fields: {
        customer_name:  { value: '众米科技（微米）',         status: 'known' },
        region:         { value: '墨西哥',                  status: 'known' },
        business_line:  { value: '现金贷',                  status: 'known' },
        product_type:   { value: '现金贷',                  status: 'known' },
        cust_total:     { value: '约120万',                  status: 'filled', sources: [{ url: 'https://example.com/36kr', title: '36氪报道' }] },
        monthly_loans:  { values: ['约20万', '约15万'],        status: 'conflict',
                          sources: [{ url: 'https://example.com/yj1', title: '行业报告' },
                                    { url: 'https://example.com/yj2', title: '年报推算' }] },
      }
    }
  ];
  const out = await exportV2(TMP_V2, customers);
  assert.ok(fs.existsSync(out));

  // 读回验证：表头 = 启用字段数 + "模型一致性" 列 + 冲突单元格红底
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const ws = wb.getWorksheet('客户调研总表');
  assert.ok(ws, 'sheet1 存在');
  assert.equal(ws.getRow(1).cellCount, getActiveFields().length + 1);
  // 找 "月放款笔数" 列号（冲突字段）
  let badDebtCol = -1;
  ws.getRow(1).eachCell((cell, col) => { if (String(cell.value) === '月放款笔数') badDebtCol = col; });
  assert.ok(badDebtCol > 0);
  const cell = ws.getRow(2).getCell(badDebtCol);
  assert.match(String(cell.value), /约20万; 约15万/);
  assert.equal(cell.fill?.fgColor?.argb, 'FFFCE4E4', '冲突单元格应为红底');

  // sheet2 来源数 ≥ 3
  const ws2 = wb.getWorksheet('字段来源');
  assert.ok(ws2.rowCount >= 4); // header + 3 sources
});
