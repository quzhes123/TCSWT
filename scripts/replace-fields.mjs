// 商务通 · 字段管理替换脚本
// 用途：把 db.field_defs 替换为 22 个新字段定义（来自用户提供的字段表 + 含义/数据源/URL 补全）
// 安全：① 仅替换 field_defs,不动 customers/results/sources/report_versions/models
//       ② 运行前 db.json 应已备份;运行多次幂等（每次都是同一份新字段）
// 使用：node scripts/replace-fields.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '..', 'data', 'db.json');

/** 引用 URL（结构化数据源网址） */
const URL = {
  qcc:        { name: '企查查', url: 'https://www.qcc.com/' },
  tianyan:    { name: '天眼查', url: 'https://www.tianyancha.com/' },
  gsxt:       { name: '国家企业信用信息公示系统', url: 'https://www.gsxt.gov.cn/' },
  cninfo:     { name: '巨潮资讯网', url: 'http://www.cninfo.com.cn/' },
  wind:       { name: 'Wind', url: 'https://www.wind.com.cn/' },
  ifind:      { name: '同花顺 iFinD', url: 'https://www.51ifind.com/' },
  edgar:      { name: 'SEC EDGAR', url: 'https://www.sec.gov/edgar' },
  starsurfun: { name: '信贷监控星盘', url: 'https://star.surfun.cn/' },
  linkedinSN: { name: 'LinkedIn Sales Navigator', url: 'https://business.linkedin.com/sales-solutions/sales-navigator' },
  linkedin:   { name: 'LinkedIn', url: 'https://www.linkedin.com/' },
  liepin:     { name: '猎聘 企业版', url: 'https://www.liepin.com/' },
  bossEnt:    { name: 'Boss 直聘 企业版', url: 'https://www.zhipin.com/' },
  maimai:     { name: '脉脉', url: 'https://maimai.cn/' },
  googlePlay: { name: 'Google Play', url: 'https://play.google.com/' },
  appstore:   { name: 'App Store', url: 'https://apps.apple.com/' },
  // 各国监管官网（牌照查询）
  cnbv:       { name: '墨西哥 CNBV', url: 'https://www.gob.mx/cnbv' },
  ojkID:      { name: '印尼 OJK', url: 'https://www.ojk.go.id/' },
  secPH:      { name: '菲律宾 SEC', url: 'https://www.sec.gov.ph/' },
  botTH:      { name: '泰国 BOT', url: 'https://www.bot.or.th/' },
  sbpPK:      { name: '巴基斯坦 SBP', url: 'https://www.sbp.org.pk/' },
};

/** 22 个新字段定义（顺序即报告展示顺序） */
const NEW_FIELDS = [
  // ── 基本信息（12 个，按用户给的顺序）──
  { key: 'customer_name', label: '公司名称', group: 'basic',
    hint: '客户运营公司全称（用作一致性校验/反查）',
    source_note: '企查查 企业版',
    reference_urls: [URL.qcc, URL.tianyan, URL.gsxt] },
  { key: 'region', label: '展业国家/地区', group: 'basic',
    hint: '客户实际开展业务的国家/地区',
    source_note: '企查查 + 应用商店',
    reference_urls: [URL.qcc, URL.googlePlay, URL.appstore] },
  { key: 'license', label: '牌照', group: 'basic',
    hint: '客户在各国持有的金融牌照（如墨西哥 SOFOM、菲律宾 OLP、印尼 OJK 备案、泰国 PLO 等）及其状态、有效期',
    source_note: '各国金融监管局官网 + 企查查',
    reference_urls: [URL.cnbv, URL.ojkID, URL.secPH, URL.botTH, URL.sbpPK, URL.qcc] },
  { key: 'annual_revenue', label: '年收入', group: 'basic', numeric: true,
    hint: '客户年度业务营收（年报披露口径，单位以原币种或人民币折算并备注）',
    source_note: '公开年报、巨潮、Wind/iFinD、SEC EDGAR',
    reference_urls: [URL.cninfo, URL.wind, URL.ifind, URL.edgar] },
  { key: 'overseas_entity', label: '海外本地主体', group: 'basic',
    hint: '客户在目标国注册的本地法人/分公司',
    source_note: '企查查（对外投资）+ 各国外商注册',
    reference_urls: [URL.qcc, URL.cnbv, URL.ojkID, URL.secPH] },
  { key: 'app_operator', label: 'APP运营主体', group: 'basic',
    hint: 'APP 实际运营的公司主体（可能与客户主体不同）',
    source_note: '应用商店开发者 + 企查查',
    reference_urls: [URL.googlePlay, URL.appstore, URL.qcc] },
  { key: 'domestic_loc', label: '国内运营地', group: 'basic',
    hint: '客户国内总部/主要办公地所在城市',
    source_note: '企查查',
    reference_urls: [URL.qcc, URL.tianyan, URL.gsxt] },
  { key: 'key_persons', label: '关键人物', group: 'basic',
    hint: '决策人（CEO/CFO/业务负责人/CTO 等）及关键影响人物当前在职状态、组织变动、对项目态度',
    source_note: 'LinkedIn Sales Navigator + 招聘平台 + 脉脉',
    reference_urls: [URL.linkedinSN, URL.linkedin, URL.liepin, URL.bossEnt, URL.maimai] },
  { key: 'business_line', label: '业务线', group: 'basic',
    hint: '客户涉及哪条业务线（风控 / AI 催收 / 营销 / 数据服务 等）',
    source_note: '官网',
    reference_urls: [] },
  { key: 'team', label: '组织架构', group: 'basic',
    hint: '客户团队规模与组成、关键部门设置（如风控部/技术部/海外事业部）',
    source_note: 'LinkedIn 公开 + 招聘平台',
    reference_urls: [URL.linkedin, URL.liepin, URL.bossEnt, URL.maimai] },
  { key: 'top_clients', label: 'TOP10 客户', group: 'basic',
    hint: '客户的主要合作客户/Top 10 重点客户名单（来自其官网案例页/媒体公开报道/客户公开演讲）',
    source_note: '官网案例页 + 媒体报道 + 客户公开演讲',
    reference_urls: [] },
  { key: 'partner_count', label: '合作客户数量', group: 'basic', numeric: true,
    hint: '客户已合作的客户/合作伙伴总数（量级，如 100+/1000+）',
    source_note: '官网/年报',
    reference_urls: [URL.cninfo] },

  // ── 业务规模（2 个）──
  { key: 'cust_total', label: '累计客户数', group: 'biz', numeric: true,
    hint: '注册或借款的累计用户数',
    source_note: '巨潮（免费）→ Wind/iFinD（深度）',
    reference_urls: [URL.cninfo, URL.edgar, URL.wind, URL.ifind] },
  { key: 'monthly_loans', label: '月放款笔数', group: 'biz', numeric: true,
    hint: '单月放款笔数（业务规模指标）',
    source_note: '公开年报',
    reference_urls: [URL.cninfo, URL.edgar, URL.wind, URL.ifind] },

  // ── APP（5 个）──
  { key: 'app_name', label: 'APP', group: 'app',
    hint: '客户对外主推的 APP 名称',
    source_note: '应用商店列表页',
    reference_urls: [URL.googlePlay, URL.appstore] },
  { key: 'app_total_dl', label: 'APP累计下载', group: 'app', numeric: true,
    hint: 'APP 上线以来在各应用商店的累计下载量',
    source_note: '信贷监控星盘（Surfun）',
    reference_urls: [URL.starsurfun] },
  { key: 'app_3m_growth', label: 'APP近3月月均增长', group: 'app', numeric: true,
    hint: '近三个月每月平均下载/活跃增量，反映业务景气度',
    source_note: '信贷监控星盘（Surfun）',
    reference_urls: [URL.starsurfun] },
  { key: 'app_ranking', label: '排名', group: 'app',
    hint: 'APP 在各应用商店的排名（含分类榜单/国家榜单/同类目排名）',
    source_note: '信贷监控星盘（Surfun）',
    reference_urls: [URL.starsurfun] },
  { key: 'app_trend', label: '趋势', group: 'app',
    hint: 'APP 下载量/活跃用户的近期走向（增长 / 下滑 / 稳定 / 波动）',
    source_note: '信贷监控星盘（Surfun）',
    reference_urls: [URL.starsurfun] },

  // ── 产品（3 个）──
  { key: 'product_type', label: '产品类型', group: 'product',
    hint: '现金贷 / 分期 / BNPL / 信用卡 等',
    source_note: '官网/应用描述',
    reference_urls: [] },
  { key: 'product_form', label: '产品形态', group: 'product',
    hint: '短期小额 / 长期分期 / 循环额度 等',
    source_note: '官网/应用描述',
    reference_urls: [] },
  { key: 'launch_time', label: '展业时间', group: 'product',
    hint: '客户进入目标市场的开始时间',
    source_note: '官网/媒体',
    reference_urls: [] },
];

// ============= 执行 =============
const raw = fs.readFileSync(DB_PATH, 'utf8');
const db = JSON.parse(raw);

const before = db.field_defs?.length || 0;

const now = Date.now();
db.field_defs = NEW_FIELDS.map((f, i) => ({
  key: f.key,
  label: f.label,
  group: f.group,
  hint: f.hint,
  source_note: f.source_note || '',
  reference_urls: Array.isArray(f.reference_urls) ? f.reference_urls : [],
  numeric: !!f.numeric,
  no_research: !!f.no_research,
  enabled: true,
  builtin: true,
  order: i,
  created_at: now,
  updated_at: now,
}));

fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');

const after = db.field_defs.length;
const withUrls = db.field_defs.filter(f => f.reference_urls.length > 0).length;
// 分组统计
const groupCount = {};
db.field_defs.forEach(f => { groupCount[f.group] = (groupCount[f.group] || 0) + 1; });
console.log(`字段定义替换完成`);
console.log(`  数量: ${before} → ${after}`);
console.log(`  含数据源网址的字段: ${withUrls} / ${after}`);
console.log(`  分组分布:`, groupCount);
console.log(`  其余数据未动: customers=${db.customers.length}, results=${db.results.length}, sources=${db.sources.length}, report_versions=${db.report_versions.length}, models=${db.models.length}`);
