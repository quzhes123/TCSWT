// 商务通 · 32 字段定义与来源映射（直接来源于 需求.md 与 表头V1.xlsx）
// 字段顺序 = 表头V1.xlsx 中 A-AF 列的真实顺序

/** @typedef {{name:string, url:string}} ReferenceUrl */
/** @typedef {{key:string, label:string, group?:string, sources?: {primary:string[], fallback:string[]}, reference_urls?:ReferenceUrl[], hint?:string }} FieldSpec */

/** 复用 URL 常量（避免重复字符串，便于统一更新） */
const URL = {
  qcc:        { name: '企查查',          url: 'https://www.qcc.com/' },
  tianyan:    { name: '天眼查',          url: 'https://www.tianyancha.com/' },
  gsxt:       { name: '国家企业信用信息公示系统', url: 'https://www.gsxt.gov.cn/' },
  cninfo:     { name: '巨潮资讯网',      url: 'http://www.cninfo.com.cn/' },
  wind:       { name: 'Wind',           url: 'https://www.wind.com.cn/' },
  ifind:      { name: '同花顺 iFinD',    url: 'https://www.51ifind.com/' },
  edgar:      { name: 'SEC EDGAR',      url: 'https://www.sec.gov/edgar' },
  starsurfun: { name: '信贷监控星盘',    url: 'https://star.surfun.cn/' },
  linkedinSN: { name: 'LinkedIn Sales Navigator', url: 'https://business.linkedin.com/sales-solutions/sales-navigator' },
  linkedin:   { name: 'LinkedIn',       url: 'https://www.linkedin.com/' },
  liepin:     { name: '猎聘 企业版',     url: 'https://www.liepin.com/' },
  bossEnt:    { name: 'Boss 直聘 企业版', url: 'https://www.zhipin.com/' },
  googlePlay: { name: 'Google Play',    url: 'https://play.google.com/' },
  appstore:   { name: 'App Store',      url: 'https://apps.apple.com/' },
  hibor:      { name: '慧博投研',        url: 'https://www.hibor.com.cn/' },
  fxbg:       { name: '发现报告',        url: 'https://www.fxbaogao.com/' },
};

/** @type {FieldSpec[]} */
export const FIELDS = [
  { key: 'customer_name',    label: '公司名称',   group: 'basic',
    sources: { primary: ['企查查', '官网', '应用商店开发者信息'], fallback: ['LinkedIn', '媒体报道'] },
    reference_urls: [URL.qcc, URL.tianyan, URL.gsxt],
    hint: '客户运营公司全称（用作一致性校验/反查）。若已知则做一致性校验；若仅提供 APP/区域，则通过应用商店开发者、官网备案等查出运营公司全称' },
  { key: 'region',           label: '展业区域',   group: 'basic',
    sources: { primary: ['企查查', '官网', '年报'], fallback: ['LinkedIn'] },
    reference_urls: [URL.qcc, URL.tianyan, URL.cninfo],
    hint: '客户实际开展业务的国家/地区' },
  { key: 'customer_level',   label: '客户等级',   group: 'basic',
    sources: { primary: ['已知或行业报告推断'], fallback: [] },
    reference_urls: [],
    hint: '内部对客户重要程度的分级（S/A/B/C 等）' },
  { key: 'app_name',         label: 'APP',       group: 'app',
    reference_urls: [URL.googlePlay, URL.appstore],
    hint: '客户对外主推的 APP 名称' },
  { key: 'app_total_dl',     label: 'APP累计下载', group: 'app',
    sources: { primary: ['信贷监控星盘', 'data.ai', 'SensorTower'], fallback: ['Similarweb'] },
    reference_urls: [URL.starsurfun],
    hint: 'APP 上线以来在各应用商店的累计下载量；海外现金贷优先用「信贷监控星盘」' },
  { key: 'app_3m_growth',    label: 'APP近3月月均增长', group: 'app',
    sources: { primary: ['信贷监控星盘', 'data.ai', 'SensorTower'], fallback: ['Similarweb'] },
    reference_urls: [URL.starsurfun],
    hint: '近三个月每月平均下载/活跃增量，反映业务景气度' },
  { key: 'product_type',     label: '产品类型',   group: 'product',
    reference_urls: [URL.googlePlay, URL.appstore],
    hint: '现金贷 / 分期 / BNPL / 信用卡 等' },
  { key: 'product_form',     label: '产品形态',   group: 'product',
    reference_urls: [URL.googlePlay, URL.appstore],
    hint: '短期小额 / 长期分期 / 循环额度 等' },
  { key: 'launch_time',      label: '展业时间',   group: 'product',
    reference_urls: [],
    hint: '客户进入目标市场的开始时间' },
  { key: 'cust_total',       label: '累计客户数', group: 'biz',
    sources: { primary: ['公开年报', '巨潮资讯网', 'SEC EDGAR'], fallback: ['官网', '媒体报道'] },
    reference_urls: [URL.cninfo, URL.edgar, URL.wind, URL.ifind],
    hint: '注册或借款的累计用户数' },
  { key: 'monthly_loans',    label: '月放款笔数', group: 'biz',
    sources: { primary: ['公开年报'], fallback: ['行业报告'] },
    reference_urls: [URL.cninfo, URL.edgar, URL.wind, URL.ifind],
    hint: '单月放款笔数（业务规模指标）' },
  { key: 'bad_debt_rate',    label: '坏账率',     group: 'biz',
    sources: { primary: ['公开年报', '巨潮资讯网'], fallback: ['行业报告估算'] },
    reference_urls: [URL.cninfo, URL.edgar, URL.wind, URL.ifind],
    hint: 'M3+ 或 NPL 不良率。若年报未直披露，可按 信用减值损失/贷款总额 推算并标注推理过程' },
  { key: 'multi_loans',      label: '人均多头',   group: 'biz',
    sources: { primary: ['行业报告', '公开年报'], fallback: ['媒体报道'] },
    reference_urls: [URL.hibor, URL.fxbg, URL.cninfo],
    hint: '单一客户在多家平台同时借款的平均数' },
  { key: 'data_need',        label: '数据需求',   group: 'data',
    reference_urls: [],
    hint: '客户对风控/营销/催收的具体数据采购需求' },
  { key: 'data_partners',    label: '已对接数据产品&数据源', group: 'data',
    sources: { primary: ['官网', '招聘信息'], fallback: ['媒体报道'] },
    reference_urls: [URL.liepin, URL.bossEnt],
    hint: '客户当前已采购/合作的第三方数据产品' },
  { key: 'data_budget',      label: '数据服务预算', group: 'data',
    sources: { primary: ['公开年报推算', '招聘信息'], fallback: ['行业对标'] },
    reference_urls: [URL.liepin, URL.bossEnt, URL.cninfo],
    hint: '客户每年在数据采购上的总预算' },
  { key: 'collection_info',  label: '催收情况（流程、催回率、痛点）', group: 'collection',
    sources: { primary: ['招聘信息', '官网', '年报（诉讼披露）'], fallback: ['媒体报道'] },
    reference_urls: [URL.liepin, URL.bossEnt, URL.cninfo],
    hint: '催收流程、催回率、当前痛点' },
  { key: 'ai_collection_interest', label: '对AI催收机器人是否感兴趣、具体需求', group: 'collection',
    sources: { primary: ['招聘信息（催收/技术岗JD）', '年报战略'], fallback: ['媒体报道'] },
    reference_urls: [URL.liepin, URL.bossEnt, URL.cninfo],
    hint: '客户对 AI 催收机器人的兴趣与具体需求（通过 JD 信号判断）' },
  { key: 'key_decision_maker', label: '关键决策人状态', group: 'people',
    sources: { primary: ['LinkedIn', '公司新闻', '年报致股东信'], fallback: ['官网团队页面'] },
    reference_urls: [URL.linkedinSN, URL.linkedin],
    hint: '关键决策人当前在职状态、组织变动、对项目态度' },
  { key: 'jun_business_target', label: '6月商务目标', group: 'goal',
    reference_urls: [],
    hint: '销售本月需在该客户达成的商务节点（内部）' },
  { key: 'q2_revenue_estimate', label: 'Q2预计营收', group: 'goal',
    sources: { primary: ['公开年报指引'], fallback: ['券商研报', '媒体报道'] },
    reference_urls: [URL.cninfo, URL.wind, URL.hibor, URL.fxbg],
    hint: '客户本季度预测营收' },
  { key: 'jun_biz_target',   label: '6月业务目标', group: 'goal',
    reference_urls: [],
    hint: '销售本月对该客户的业务目标（内部）' },
  { key: 'current_blocker',  label: '当前关键卡点', group: 'goal',
    sources: { primary: ['年报MD&A', '致股东信', '媒体访谈'], fallback: ['招聘倾向推断'] },
    reference_urls: [URL.cninfo, URL.edgar],
    hint: '客户业务卡点 / 我方推进卡点' },
  { key: 'support_needed',   label: '所需支持',   group: 'goal',
    reference_urls: [],
    hint: '推进该客户所需的内部资源支持（内部）' },
  { key: 'core_strategy',    label: '核心策略',   group: 'goal',
    reference_urls: [URL.cninfo, URL.edgar],
    hint: '我方对该客户的核心打法/战略' },
  { key: 'business_line',    label: '业务线',     group: 'meta',
    reference_urls: [],
    hint: '涉及哪条业务线（风控 / AI催收 / 营销 等）' },
  { key: 'app_operator',     label: 'APP运营主体', group: 'meta',
    reference_urls: [URL.qcc, URL.tianyan, URL.googlePlay, URL.appstore],
    hint: 'APP 实际运营的公司主体（可能与客户主体不同）' },
  { key: 'key_persons',      label: '关键人物',   group: 'meta',
    sources: { primary: ['LinkedIn', '官网团队页面'], fallback: ['媒体报道'] },
    reference_urls: [URL.linkedinSN, URL.linkedin],
    hint: '决策人之外影响购买的关键人物（CTO / 业务负责人 等）' },
  { key: 'team',             label: '团队',       group: 'meta',
    reference_urls: [URL.linkedin, URL.liepin, URL.bossEnt],
    hint: '客户团队规模与组成' },
  { key: 'overseas_entity',  label: '海外本地主体', group: 'meta',
    sources: { primary: ['企查查（对外投资）', '各国外商注册信息'], fallback: ['官网联系我们', 'LinkedIn'] },
    reference_urls: [URL.qcc, URL.tianyan],
    hint: '客户在目标国注册的本地法人/分公司' },
  { key: 'domestic_loc',     label: '国内运营地', group: 'meta',
    sources: { primary: ['企查查', '官网'], fallback: [] },
    reference_urls: [URL.qcc, URL.tianyan, URL.gsxt],
    hint: '客户国内总部/主要办公地所在城市' },
  { key: 'remark',           label: '备注',       group: 'meta',
    reference_urls: [],
    hint: '其他补充信息（内部，不参与调研）' },
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
