// 按用户附件清单：清空 db.field_defs，按附件顺序+分组重灌
import fs from 'node:fs';
import path from 'node:path';

const DB_FILE = path.resolve('./data/db.json');
const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

const URL = {
  qcc: { name: '企查查', url: 'https://www.qcc.com/' },
  qcc_overseas: { name: '企查查（对外投资）', url: 'https://www.qcc.com/' },
  appstore: { name: 'App Store', url: 'https://apps.apple.com/' },
  googlePlay: { name: 'Google Play', url: 'https://play.google.com/' },
  linkedinSN: { name: 'LinkedIn Sales Navigator', url: 'https://business.linkedin.com/sales-solutions/sales-navigator' },
  liepin: { name: '猎聘', url: 'https://www.liepin.com/' },
  zhipin: { name: 'Boss 直聘', url: 'https://www.zhipin.com/' },
  maimai: { name: '脉脉', url: 'https://maimai.cn/' },
  linkedin: { name: 'LinkedIn', url: 'https://www.linkedin.com/' },
  starsurfun: { name: '信贷监控星盘（Surfun）', url: 'https://star.surfun.cn/' },
  cninfo: { name: '巨潮资讯网', url: 'http://www.cninfo.com.cn/' },
  wind: { name: 'Wind', url: 'https://www.wind.com.cn/' },
  ifind: { name: '同花顺 iFinD', url: 'https://www.51ifind.com/' },
};

// 严格按附件顺序
const ROWS = [
  // —— 基本信息（用户明确归在 basic）——
  { key: 'customer_name', label: '公司名称', group: 'basic',
    hint: '客户运营公司全称（用作一致性校验/反查）',
    source_note: '优先来源：企查查 企业版',
    reference_urls: [URL.qcc] },
  { key: 'region', label: '展业国家/地区', group: 'basic',
    hint: '客户实际开展业务的国家/地区',
    source_note: '优先来源：企查查 + 应用商店',
    reference_urls: [URL.qcc, URL.googlePlay, URL.appstore] },
  { key: 'license', label: '牌照', group: 'basic',
    hint: '客户在展业国家/地区持有的金融或类金融牌照（如放贷牌照、支付牌照、消费金融牌照等）',
    source_note: '优先来源：当地金融监管官网；备选：企查查、官网披露',
    reference_urls: [URL.qcc] },
  { key: 'annual_revenue', label: '年收入', group: 'basic',
    hint: '客户最近一个完整财年的业务营收',
    source_note: '优先来源：年报/招股书（巨潮）；备选：Wind、iFinD、媒体披露',
    reference_urls: [URL.cninfo, URL.wind, URL.ifind] },

  // —— 主体/组织（meta）——
  { key: 'overseas_entity', label: '海外本地主体', group: 'meta',
    hint: '客户在目标国注册的本地法人/分公司',
    source_note: '优先来源：企查查（对外投资）+ 各国外商注册官网',
    reference_urls: [URL.qcc_overseas] },
  { key: 'app_operator', label: 'APP运营主体', group: 'meta',
    hint: 'APP 实际运营的公司主体（可能与客户主体不同）',
    source_note: '优先来源：应用商店开发者信息 + 企查查',
    reference_urls: [URL.qcc, URL.googlePlay, URL.appstore] },
  { key: 'domestic_loc', label: '国内运营地', group: 'meta',
    hint: '客户国内总部/主要办公地所在城市',
    source_note: '优先来源：企查查',
    reference_urls: [URL.qcc] },

  // —— 关键人物/团队（people）——
  { key: 'key_persons', label: '关键人物', group: 'people',
    hint: '决策人之外影响购买的关键人物（CTO/业务负责人等），含在职状态',
    source_note: '优先来源：LinkedIn Sales Navigator；备选：猎聘、Boss 直聘、脉脉',
    reference_urls: [URL.linkedinSN, URL.liepin, URL.zhipin, URL.maimai] },
  { key: 'business_line', label: '业务线', group: 'people',
    hint: '客户涉及的业务线（风控/AI催收/营销等）',
    source_note: '优先来源：客户官网',
    reference_urls: [] },
  { key: 'org_structure', label: '组织架构', group: 'people',
    hint: '客户团队规模与组成',
    source_note: '优先来源：LinkedIn 公开信息 + 招聘平台',
    reference_urls: [URL.linkedin, URL.liepin, URL.zhipin] },

  // —— 商务/客户（biz）——
  { key: 'top10_customers', label: 'TOP10 客户', group: 'biz',
    hint: '客户对外披露的前十大合作客户/合作伙伴',
    source_note: '官网案例、年报/招股书披露、媒体报道',
    reference_urls: [URL.cninfo] },
  { key: 'partner_count', label: '合作客户数量', group: 'biz',
    hint: '客户对外披露的合作客户/合作机构数量',
    source_note: '官网披露、年报、新闻通稿',
    reference_urls: [] },

  // —— APP / 产品（app）——
  { key: 'app_name', label: 'APP', group: 'app',
    hint: '客户对外主推的 APP 名称',
    source_note: '应用商店列表页',
    reference_urls: [URL.googlePlay, URL.appstore] },
  { key: 'app_total_dl', label: 'APP累计下载', group: 'app',
    hint: 'APP 上线以来在各应用商店的累计下载量',
    source_note: '信贷监控星盘（Surfun）',
    reference_urls: [URL.starsurfun] },
  { key: 'app_3m_growth', label: 'APP近3月月均增长', group: 'app',
    hint: '近三个月每月平均下载/活跃增量',
    source_note: '信贷监控星盘（Surfun）',
    reference_urls: [URL.starsurfun] },
  { key: 'app_rank', label: '排名', group: 'app',
    hint: 'APP 在目标市场应用商店的当前榜单排名',
    source_note: '信贷监控星盘（Surfun）',
    reference_urls: [URL.starsurfun] },
  { key: 'app_trend', label: '趋势', group: 'app',
    hint: 'APP 关键指标（下载/活跃/排名）的近期走势',
    source_note: '信贷监控星盘（Surfun）',
    reference_urls: [URL.starsurfun] },

  // —— 产品（product）——
  { key: 'product_type', label: '产品类型', group: 'product',
    hint: '现金贷/分期/BNPL/信用卡 等',
    source_note: '官网/应用描述',
    reference_urls: [] },
  { key: 'product_form', label: '产品形态', group: 'product',
    hint: '短期小额/长期分期/循环额度 等',
    source_note: '官网/应用描述',
    reference_urls: [] },
  { key: 'launch_time', label: '展业时间', group: 'product',
    hint: '客户进入目标市场的开始时间',
    source_note: '官网/媒体报道',
    reference_urls: [] },

  // —— 业务规模（scale）——
  { key: 'cust_total', label: '累计客户数', group: 'scale',
    hint: '注册或借款的累计用户数',
    source_note: '巨潮（免费）→ Wind/iFinD（深度）',
    reference_urls: [URL.cninfo, URL.wind, URL.ifind] },
  { key: 'monthly_loans', label: '月放款笔数', group: 'scale',
    hint: '单月放款笔数（业务规模指标）',
    source_note: '巨潮（免费）→ Wind/iFinD（深度）',
    reference_urls: [URL.cninfo, URL.wind, URL.ifind] },
];

const NUMERIC = new Set(['app_total_dl', 'app_3m_growth', 'partner_count', 'cust_total', 'monthly_loans', 'annual_revenue']);

const now = Date.now();
raw.field_defs = ROWS.map((r, i) => ({
  key: r.key,
  label: r.label,
  group: r.group,
  hint: r.hint || '',
  source_note: r.source_note || '',
  reference_urls: r.reference_urls || [],
  numeric: NUMERIC.has(r.key),
  no_research: false,
  enabled: true,
  builtin: true,
  order: i,
  created_at: now,
  updated_at: now,
}));

fs.writeFileSync(DB_FILE, JSON.stringify(raw, null, 2));
console.log('wrote', raw.field_defs.length, 'field_defs');
console.log(raw.field_defs.map(f => `[${f.order}] ${f.group}/${f.key} - ${f.label}`).join('\n'));
