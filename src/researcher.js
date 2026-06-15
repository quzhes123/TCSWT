// 调研引擎：driver 抽象 + 受控搜索（client-side tools）
// 不再直接依赖某个 SDK；通过 src/models/driver-* 访问任意厂商。
// 工具模式 unchanged：tools=[web_search(client), fetch_page(client), record_finding]，Node 端真正执行 web/fetch。

import { FIELD_BY_KEY, NO_RESEARCH_FIELDS } from './field-spec.js';
import { detectConflict } from './excel-io.js';
import { webSearch, fetchPage, SEARCH_ENABLED } from './serp.js';

const MAX_LOOPS = 6;             // 单字段最多 agent 步数（防失控；最后一轮会强制 record_finding）
const MAX_FETCH_PER_FIELD = 4;   // 单字段最多抓取页数
const DEBUG = process.env.RESEARCH_DEBUG === '1';

// 客户端工具：web_search + fetch_page；最终落点：record_finding
const TOOLS = [
  {
    name: 'web_search',
    description: '通过外部搜索引擎检索网页。返回若干条 {title, url, snippet}。需要先用此工具拿候选 URL，再用 fetch_page 取详细内容。',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '搜索关键词，建议含公司名+字段+优先来源关键词，如 "众米科技 累计客户数 36氪"' },
      },
      required: ['query'],
    },
  },
  {
    name: 'fetch_page',
    description: '抓取指定 URL 的网页正文（去标签后的文本，最多 6000 字）。仅用于 web_search 返回的候选 URL。',
    input_schema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
    },
  },
  {
    name: 'record_finding',
    description: '调研结束时调用一次，记录最终结论。禁止在没有可信来源时编造数值；查不到给 status=unknown。',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['filled', 'agree', 'conflict', 'unknown'] },
        value: { type: 'string', description: 'filled/agree 必填；conflict 时填查到的不同值（已知值由 server 自动并入）' },
        reason: { type: 'string', description: '简短结论说明 / 推算口径 / 为什么 unknown' },
        confidence: { type: 'number', minimum: 0, maximum: 1 },
        sources: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              url: { type: 'string' },
              title: { type: 'string' },
              evidence: { type: 'string', description: '原文佐证句（≤120 字），必须出自 fetch_page 的 text' },
            },
            required: ['url'],
          },
        },
      },
      required: ['status'],
    },
  },
];

function buildSystemPrompt() {
  return [
    '你是资深市场调研分析师，专长金融科技 / 海外现金贷 / 数据服务 行业的公司调研。',
    '可用工具：',
    '- web_search(query): 拿候选 URL 列表（必须先做这一步）',
    '- fetch_page(url): 抓取候选 URL 的页面文本（拿到值 + 佐证句）',
    '- record_finding(...): 任务终点，调用一次后结束',
    '',
    '硬性规则：',
    '1) 每条事实必须出自 fetch_page 抓回的页面文本；不许凭训练记忆给数值。',
    '2) 至少做 1 次 web_search；高价值字段（坏账率/累计客户数/数据预算等）至少抓 2 个独立来源交叉验证。',
    '3) sources 中的 evidence 必须是 fetch_page text 的子串/原文摘录。',
    '4) 完全查不到 → status=unknown，留空 value，给 reason 解释。',
    '5) 一致性校验场景：与已知值一致 → agree；矛盾 → conflict；查不到 → unknown。',
    '6) 完成后必须调一次 record_finding 终止；不要在最终文本里再给值。',
  ].join('\n');
}

function fieldGuidance(spec) {
  const lines = [];
  if (spec.sources?.primary?.length) lines.push(`优先来源：${spec.sources.primary.join('、')}`);
  if (spec.sources?.fallback?.length) lines.push(`备选来源：${spec.sources.fallback.join('、')}`);
  if (spec.hint) lines.push(`提示：${spec.hint}`);
  return lines.join('\n');
}

function buildInitialUser({ customer, fieldKey, knownValue, mode, spec }) {
  const ctxLines = Object.entries(customer.raw_known || {})
    .filter(([, v]) => v && String(v).trim())
    .map(([k, v]) => `- ${FIELD_BY_KEY[k]?.label || k}: ${v}`);
  const ctx = ctxLines.length ? `\n## 客户已知信息（基准上下文，供 query 构造参考）\n${ctxLines.join('\n')}` : '';
  const guide = fieldGuidance(spec);

  if (mode === 'verify') {
    return [
      `# 任务：一致性校验`,
      `客户：${customer.customer_name}`,
      `字段：${spec.label}`,
      `表中已有值：${knownValue}`,
      ``,
      `请用 web_search + fetch_page 找公开来源核对：`,
      `- 与"已有值"一致 → record_finding(status=agree, value=官方表述, sources=[...])`,
      `- 与"已有值"矛盾 → record_finding(status=conflict, value=查到的不同值, sources=[...])`,
      `- 查不到 → record_finding(status=unknown)`,
      ``,
      guide ? `## 调研指引\n${guide}` : '',
      ctx,
    ].filter(Boolean).join('\n');
  }
  // fill
  return [
    `# 任务：补全缺失字段`,
    `客户：${customer.customer_name}`,
    `字段：${spec.label}（当前为空）`,
    ``,
    `请按以下流程：`,
    `1) 用 web_search 搜 "${customer.customer_name} ${spec.label}" 等关键词，叠加优先来源（如年报、巨潮、SEC EDGAR、36氪、LinkedIn 等）`,
    `2) 选 1–3 条最相关 URL，逐一 fetch_page 拿正文`,
    `3) 从正文中提取值与佐证句，调 record_finding(status=filled, value, reason, confidence, sources)`,
    `4) 若多源不一致 → status=conflict, value 用 ;分号串联，reason 解释差异`,
    `5) 完全查不到 → status=unknown`,
    ``,
    guide ? `## 调研指引\n${guide}` : '',
    ctx,
  ].filter(Boolean).join('\n');
}

/** 执行客户端工具：返回 { tool_use_id, content } 给模型 */
async function execClientTool(toolUse, state) {
  const { name, input, id } = toolUse;
  if (name === 'web_search') {
    const r = await webSearch(input?.query || '');
    state.searchCount += 1;
    if (!r.ok) {
      // 给模型一个明确的终结信号：禁用/失败时直接调 record_finding(unknown)，不要再换关键词试
      const guidance = !SEARCH_ENABLED
        ? '搜索引擎未配置（管理员未提供 SERPAPI_API_KEY）。请立即调用 record_finding 设 status=unknown，并在 reason 里说明缺少搜索能力。'
        : '本次搜索失败：' + r.reason + '。如多次失败请直接调 record_finding(unknown)。';
      return mkResult(id, { error: r.reason, query: input?.query, results: [], guidance });
    }
    if (r.results.length === 0) {
      return mkResult(id, { query: r.query, results: [], guidance: '本次查询无结果。可换关键词；若已尝试 ≥2 次均无果请直接 record_finding(unknown)。' });
    }
    return mkResult(id, { query: r.query, results: r.results });
  }
  if (name === 'fetch_page') {
    if (state.fetchCount >= MAX_FETCH_PER_FIELD) {
      return mkResult(id, { error: `已达单字段最大抓取次数 ${MAX_FETCH_PER_FIELD}` });
    }
    state.fetchCount += 1;
    const r = await fetchPage(input?.url || '');
    return mkResult(id, r.ok ? { url: r.url, title: r.title, text: r.text } : { error: r.reason, url: input?.url });
  }
  return mkResult(id, { error: `unknown tool: ${name}` });
}

function mkResult(tool_use_id, payload) {
  return {
    type: 'tool_result',
    tool_use_id,
    content: JSON.stringify(payload).slice(0, 30000), // 给个上限
  };
}

/**
 * 调研单字段（agentic loop：模型决策 → 我们执行工具 → 喂回 → 直到 record_finding 或上限）
 * @param {object} args
 * @param {object} args.customer
 * @param {string} args.fieldKey - 字段 key（预定义字段在 FIELD_BY_KEY 中；自定义字段需配合 spec）
 * @param {object} [args.spec]   - 自定义字段时显式传入 {key, label, hint?, sources?}；预定义字段忽略此项
 * @param {'verify'|'fill'} [args.mode]
 * @param {object} args.driver - 来自 src/models/registry 的 driver 实例（必传）
 */
export async function researchField({ customer, fieldKey, spec: customSpec, mode, driver }) {
  // 优先用显式传入的 spec（自定义字段）；否则查预定义字典
  const spec = customSpec || FIELD_BY_KEY[fieldKey];
  if (!spec) throw new Error(`未知字段：${fieldKey}`);
  if (NO_RESEARCH_FIELDS.has(fieldKey)) {
    return { result: { status: 'known', value: customer.raw_known?.[fieldKey] || '' }, sources: [] };
  }
  if (!driver) throw new Error('researchField 需要 driver 实例');
  const modelTag = driver.id;

  const knownValue = customer.raw_known?.[fieldKey] || '';
  const actualMode = mode || (knownValue ? 'verify' : 'fill');

  const system = buildSystemPrompt();
  const messages = [{ role: 'user', content: buildInitialUser({ customer, fieldKey, knownValue, mode: actualMode, spec }) }];
  const state = { searchCount: 0, fetchCount: 0 };

  let recordFinding = null;
  const FORCE_HINT = '请基于已收集的信息立即调用 record_finding 给出最终结论。如果信息不足以确定值，使用 status=unknown，并在 reason 里说明原因。不要再调用 web_search/fetch_page。';

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const forceFinish = (loop === MAX_LOOPS - 1);
    let resp;
    try {
      resp = await driver.chat({
        system,
        tools: TOOLS,
        messages: forceFinish ? messages.concat({ role: 'user', content: FORCE_HINT }) : messages,
        toolChoice: forceFinish ? { type: 'tool', name: 'record_finding' } : undefined,
        maxTokens: 2000,
      });
    } catch (e) {
      const msg = String(e?.message || e);
      if (/429|5\d\d|timeout|ECONN|network|abort/i.test(msg) && loop < 2) {
        await new Promise(r => setTimeout(r, 800 * (loop + 1)));
        continue;
      }
      return { result: { status: 'unknown', reason: 'LLM 调用失败：' + msg, model: modelTag }, sources: [] };
    }

    if (DEBUG) {
      const blocks = (resp.toolUses || []).map(b => `tool_use:${b.name}`).join(',') || (resp.text ? 'text' : 'none');
      console.log(`[research] ${customer.customer_name}/${fieldKey} [${driver.displayName}] loop=${loop}${forceFinish?'(force)':''} stop=${resp.stopReason} blocks=[${blocks}] search=${state.searchCount} fetch=${state.fetchCount}`);
    }

    // 维持对话历史：forceFinish 时把那条提示也加到 messages 里防漂移
    if (forceFinish) messages.push({ role: 'user', content: FORCE_HINT });
    messages.push({ role: 'assistant', content: resp.assistantContent || [] });

    const toolUses = resp.toolUses || [];
    const final = toolUses.find(t => t.name === 'record_finding');
    if (final) { recordFinding = final.input || {}; break; }

    if (toolUses.length === 0) {
      // 无工具调用且无 record_finding：模型卡住，结束
      break;
    }

    // 执行所有 client tool 调用，把结果作为 user/tool_result 喂回
    const results = [];
    for (const tu of toolUses) {
      results.push(await execClientTool(tu, state));
    }
    messages.push({ role: 'user', content: results });
  }

  if (!recordFinding) {
    return { result: { status: 'unknown', reason: '未在限定步数内得出结论', model: modelTag, _stat: state }, sources: [] };
  }

  const out = {
    status: recordFinding.status || 'unknown',
    value: recordFinding.value || '',
    reason: recordFinding.reason || '',
    confidence: typeof recordFinding.confidence === 'number' ? recordFinding.confidence : null,
    known_value: knownValue || null,
    model: modelTag,
    _stat: state,
  };
  // verify 模式下二次冲突判定（双保险）
  if (actualMode === 'verify' && knownValue && out.value) {
    const judged = detectConflict(fieldKey, knownValue, out.value);
    if (judged === 'conflict' && out.status !== 'conflict') {
      out.status = 'conflict';
      out.values = [knownValue, out.value];
    }
  }
  // conflict 时如未显式 values，自动并入
  if (out.status === 'conflict' && !out.values) {
    out.values = [knownValue, out.value].filter(Boolean);
  }
  // 过滤模型偶尔返回的空对象/无 url 的脏数据
  const cleanSources = (recordFinding.sources || []).filter(s => s && typeof s === 'object' && String(s.url || '').trim());
  return { result: out, sources: cleanSources };
}

export { SEARCH_ENABLED };
