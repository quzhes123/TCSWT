// 一次性脚本：构造一个 demo V1 xlsx,含多家真实可调研客户
import ExcelJS from 'exceljs';
import { EXCEL_COLUMN_LABELS } from '../src/field-spec.js';

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet('Sheet1');
ws.addRow(EXCEL_COLUMN_LABELS);

// 32 列顺序: customer_name, region, customer_level, remark, app_name, app_total_dl, app_3m_growth,
// product_type, product_form, launch_time, cust_total, monthly_loans, bad_debt_rate, multi_loans,
// data_need, data_partners, data_budget, collection_info, ai_collection_interest, key_decision_maker,
// jun_business_target, q2_revenue_estimate, jun_biz_target, current_blocker, support_needed,
// core_strategy, business_line, app_operator, key_persons, team, overseas_entity, domestic_loc

// 客户 1: 众米科技(私有,墨西哥现金贷)— 沿用真实样例
ws.addRow([
  '众米科技（微米）','墨西哥','重要客户','','TruCred - Préstamo Expreso Móvil','','','现金贷',
  '24年展业，3个包，25年9月至26年3月放量较猛','2024年','','1-3万','','','','','','','','',
  '','','','','','','','CADENA DE EXTENSION SA DE CV','微米（庄晏）/投资众米（温烨）',
  '蔡晓川、陈梁志、石教锦、郑佳铭','',''
]);

// 客户 2: 信也科技 FINV(NYSE 上市,有 SEC 10-K)— AI 应能补出大量真实字段
ws.addRow([
  '信也科技','中国/印尼','重要客户','纽交所上市 NYSE:FINV','拍拍贷 / FinVoo','','','助贷/消费金融',
  '科技赋能金融机构','2007年','','','','','','','','','','',
  '','','','','','','信贷科技服务','信也科技集团有限公司','','','信也科技集团有限公司','上海'
]);

// 客户 3: LexinFintech LX (Nasdaq 上市)— 美股真实可查
ws.addRow([
  '乐信','中国','重点客户','纳斯达克上市 NASDAQ:LX','分期乐 / 乐花卡','','','分期消费/助贷',
  '年轻人分期消费场景','2013年','','','','','','','','','','',
  '','','','','','','分期消费金融','深圳乐信控股有限公司','肖文杰 (CEO)','','深圳乐信控股','深圳'
]);

await wb.xlsx.writeFile('d:/AI项目/商务通/demo-V1.xlsx');
console.log('已生成 d:/AI项目/商务通/demo-V1.xlsx,3 条客户记录');
