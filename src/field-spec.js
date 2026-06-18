// 商务通 · 32 字段定义与来源映射（直接来源于 需求.md 与 表头V1.xlsx）
// 字段顺序 = 表头V1.xlsx 中 A-AF 列的真实顺序

/** @typedef {{key:string, label:string, group?:string, sources?: {primary:string[], fallback:string[]}, hint?:string }} FieldSpec */

/** @type {FieldSpec[]} */
export const FIELDS = [
  { key: 'customer_name',    label: '公司名称',   group: 'basic',
    sources: { primary: ['企查查', '官网', '应用商店开发者信息'], fallback: ['LinkedIn', '媒体报道'] },
    hint: '若已知则做一致性校验；若仅提供 APP/区域，则通过应用商店开发者、官网备案等查出运营公司全称' },
  { key: 'region',           label: '展业区域',   group: 'basic',
    sources: { primary: ['企查查', '官网', '年报'], fallback: ['LinkedIn'] } },
  { key: 'customer_level',   label: '客户等级',   group: 'basic',
    sources: { primary: ['已知或行业报告推断'], fallback: [] } },
  { key: 'remark',           label: '备注',       group: 'basic' },
  { key: 'app_name',         label: 'APP',       group: 'app' },
  { key: 'app_total_dl',     label: 'APP累计下载', group: 'app',
    sources: { primary: ['App Annie', 'Data.ai', 'SensorTower'], fallback: ['Similarweb'] } },
  { key: 'app_3m_growth',    label: 'APP近3月月均增长', group: 'app',
    sources: { primary: ['App Annie', 'Data.ai', 'SensorTower'], fallback: ['Similarweb'] } },
  { key: 'product_type',     label: '产品类型',   group: 'product' },
  { key: 'product_form',     label: '产品形态',   group: 'product' },
  { key: 'launch_time',      label: '展业时间',   group: 'product' },
  { key: 'cust_total',       label: '累计客户数', group: 'biz',
    sources: { primary: ['公开年报', '巨潮资讯网', 'SEC EDGAR'], fallback: ['官网', '媒体报道'] } },
  { key: 'monthly_loans',    label: '月放款笔数', group: 'biz',
    sources: { primary: ['公开年报'], fallback: ['行业报告'] } },
  { key: 'bad_debt_rate',    label: '坏账率',     group: 'biz',
    sources: { primary: ['公开年报', '巨潮资讯网'], fallback: ['行业报告估算'] },
    hint: '若年报未直披露，可按 信用减值损失/贷款总额 推算并标注推理过程' },
  { key: 'multi_loans',      label: '人均多头',   group: 'biz',
    sources: { primary: ['行业报告', '公开年报'], fallback: ['媒体报道'] } },
  { key: 'data_need',        label: '数据需求',   group: 'data' },
  { key: 'data_partners',    label: '已对接数据产品&数据源', group: 'data',
    sources: { primary: ['官网', '招聘信息'], fallback: ['媒体报道'] } },
  { key: 'data_budget',      label: '数据服务预算', group: 'data',
    sources: { primary: ['公开年报推算', '招聘信息'], fallback: ['行业对标'] } },
  { key: 'collection_info',  label: '催收情况（流程、催回率、痛点）', group: 'collection',
    sources: { primary: ['招聘信息', '官网', '年报（诉讼披露）'], fallback: ['媒体报道'] } },
  { key: 'ai_collection_interest', label: '对AI催收机器人是否感兴趣、具体需求', group: 'collection',
    sources: { primary: ['招聘信息（催收/技术岗JD）', '年报战略'], fallback: ['媒体报道'] } },
  { key: 'key_decision_maker', label: '关键决策人状态', group: 'people',
    sources: { primary: ['LinkedIn', '公司新闻', '年报致股东信'], fallback: ['官网团队页面'] } },
  { key: 'jun_business_target', label: '6月商务目标', group: 'goal' },
  { key: 'q2_revenue_estimate', label: 'Q2预计营收', group: 'goal',
    sources: { primary: ['公开年报指引'], fallback: ['券商研报', '媒体报道'] } },
  { key: 'jun_biz_target',   label: '6月业务目标', group: 'goal' },
  { key: 'current_blocker',  label: '当前关键卡点', group: 'goal',
    sources: { primary: ['年报MD&A', '致股东信', '媒体访谈'], fallback: ['招聘倾向推断'] } },
  { key: 'support_needed',   label: '所需支持',   group: 'goal' },
  { key: 'core_strategy',    label: '核心策略',   group: 'goal' },
  { key: 'business_line',    label: '业务线',     group: 'meta' },
  { key: 'app_operator',     label: 'APP运营主体', group: 'meta' },
  { key: 'key_persons',      label: '关键人物',   group: 'meta',
    sources: { primary: ['LinkedIn', '官网团队页面'], fallback: ['媒体报道'] } },
  { key: 'team',             label: '团队',       group: 'meta' },
  { key: 'overseas_entity',  label: '海外本地主体', group: 'meta',
    sources: { primary: ['企查查（对外投资）', '各国外商注册信息'], fallback: ['官网联系我们', 'LinkedIn'] } },
  { key: 'domestic_loc',     label: '国内运营地', group: 'meta',
    sources: { primary: ['企查查', '官网'], fallback: [] } },
];

/** Excel A-AF 列顺序（与 FIELDS 一一对应） */
export const EXCEL_COLUMN_LABELS = FIELDS.map(f => f.label);

/** key → spec 映射 */
export const FIELD_BY_KEY = Object.fromEntries(FIELDS.map(f => [f.key, f]));

/** Excel 表头模糊匹配（兼容 🟢 emoji、空白、全/半角差异） */
export function normalizeHeader(s) {
  return String(s || '')
    .replace(/[🟢🔵🟡🔴⭐]/g, '')
    .replace(/\s+/g, '')
    .replace(/（/g, '(').replace(/）/g, ')')
    .replace(/&amp;/g, '&')
    .toLowerCase();
}

/** 常见表头别名 → 字段 key（容错：不同人对同一字段的叫法。归一化后比对） */
const HEADER_ALIASES = {
  '客户名称': 'customer_name',
  '公司': 'customer_name',
  '公司名': 'customer_name',
  'app': 'app_name',
  'app名称': 'app_name',
};

/** 把 Excel 表头数组映射到 field key 数组（找不到则原样返回 label）
 *  @param {Array} headers 表头文本数组
 *  @param {Array} [fieldList] 字段定义列表（{key,label}），默认用内置 FIELDS（向后兼容）。
 *         字段管理上线后由调用方传入 db 中的动态字段，保证表头映射随字段维护实时生效。
 */
export function mapHeadersToKeys(headers, fieldList = FIELDS) {
  const lookup = new Map((fieldList || FIELDS).map(f => [normalizeHeader(f.label), f.key]));
  // 叠加别名（仅当该 key 确实存在于字段列表中才生效）
  const validKeys = new Set((fieldList || FIELDS).map(f => f.key));
  for (const [alias, key] of Object.entries(HEADER_ALIASES)) {
    if (validKeys.has(key)) lookup.set(normalizeHeader(alias), key);
  }
  return headers.map(h => lookup.get(normalizeHeader(h)) || `__unknown:${h}`);
}

/** 调研时排除的「不需要 LLM 补全」字段（已知主键/内部备注等） */
export const NO_RESEARCH_FIELDS = new Set(['remark']);

/** 数值型字段（用于冲突阈值判断） */
export const NUMERIC_LIKE_FIELDS = new Set([
  'app_total_dl', 'app_3m_growth', 'cust_total', 'monthly_loans', 'bad_debt_rate', 'data_budget'
]);
