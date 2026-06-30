// 多模型结果合并器
// 输入：同一 (customer × field) 来自 N 个模型的原始结果 + 已知值（虚拟"已知"模型）
// 输出：合并后的最终结论 + model_summary 字段（人类可读的"哪些模型一致/冲突"摘要）
//
// 合并规则（来自 模型能力切换选择组件.md §2.3）：
//   - 全空 → status=unknown, value='待补充'
//   - 全部有效结果两两"意思相近" → agree，随机选一个值
//   - 否则 → conflict，按模型名排序拼成 "答案A(from 模型1); 答案B(from 模型2)"
// 意思相近：数值差 ≤±10% / 文本 bigram Jaccard ≥0.6 / 完全相同
// 已知值参与合并（标签 "from 已知"）

import { NUMERIC_LIKE_FIELDS } from './field-spec.js';

const NUMERIC_THRESHOLD = 0.1;     // ±10%
const TEXT_SIM_THRESHOLD = 0.6;    // bigram Jaccard

/** 数值字段判一致 */
function numericClose(a, b) {
  const na = parseFirstNumber(a);
  const nb = parseFirstNumber(b);
  if (na == null || nb == null) return null;
  const denom = Math.max(Math.abs(na), Math.abs(nb), 1e-6);
  return Math.abs(na - nb) / denom <= NUMERIC_THRESHOLD;
}
function parseFirstNumber(s) {
  const str = String(s);
  // 优先匹配带千分位的形如 "1,234.56" 或纯 "12345.67"
  const m = str.match(/-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?/);
  if (!m) return null;
  let n = parseFloat(m[0].replace(/,/g, ''));   // 移除千分位
  if (Number.isNaN(n)) return null;
  if (/万/.test(str)) n *= 10000;
  if (/亿/.test(str)) n *= 1e8;
  if (/%/.test(str)) n /= 100;
  return n;
}

/** 文本相似度（Sørensen–Dice 系数 + 短串包含特例）
 *  对中文场景比 Jaccard 更宽容，符合"意思相近"的直觉。
 *  短串完整出现在长串中 → 直接算相近（如 "CEO李铁铮" 包含于 "CEO李铁铮（在任）"）。
 */
function textSim(a, b) {
  const sa = String(a || '').replace(/\s+/g, '');
  const sb = String(b || '').replace(/\s+/g, '');
  if (!sa || !sb) return 0;
  // 包含子串特例：短串出现在长串中
  if (sa.length >= 3 || sb.length >= 3) {
    const [shorter, longer] = sa.length <= sb.length ? [sa, sb] : [sb, sa];
    if (longer.includes(shorter)) return 1;
  }
  const A = bigrams(sa), B = bigrams(sb);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  // Dice = 2|A∩B| / (|A|+|B|)
  return (2 * inter) / (A.size + B.size);
}
function bigrams(s) {
  const out = new Set();
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

/** 判定 a / b 是否"意思相近"
 *  - 完全相同 → 一致
 *  - 两者都能解析出主数值时，按数值差判定（无论是否在 NUMERIC_LIKE_FIELDS 白名单）
 *    （金额/百分比/数量等大量字段都是数值，不该被白名单挡住）
 *  - 否则按文本 Dice 相似度判定
 */
function nearlyEqual(fieldKey, a, b) {
  if (a == null || b == null) return false;
  const sa = String(a).trim(), sb = String(b).trim();
  if (!sa || !sb) return false;
  if (sa === sb) return true;
  const num = numericClose(sa, sb);
  if (num != null) return num;
  return textSim(sa, sb) >= TEXT_SIM_THRESHOLD;
}

/**
 * 合并多模型结果
 * @param {object} args
 * @param {string} args.fieldKey
 * @param {string|null} args.knownValue                   - 表中已有值（参与合并）
 * @param {Array<{modelId:string, modelName:string, status:string, value:string, sources:array, reason:string, confidence:number}>} args.modelResults
 * @returns {{ status: 'agree'|'conflict'|'unknown', value: string, values?: string[],
 *   reason: string, sources: array, model_summary: string,
 *   participants: Array<{name:string, status:string, value:string}> }}
 */
export function mergeMultiModel({ fieldKey, knownValue, modelResults }) {
  // 候选 = 已知值（如有） + 各模型有效结果
  const candidates = [];
  if (knownValue && String(knownValue).trim()) {
    candidates.push({ name: '已知', value: String(knownValue).trim(), status: 'known', sources: [] });
  }
  for (const r of (modelResults || [])) {
    const isValid = (r.status === 'filled' || r.status === 'agree' || r.status === 'conflict')
                     && r.value && String(r.value).trim();
    if (isValid) {
      candidates.push({
        name: r.modelName || r.modelId || 'model',
        value: String(r.value).trim(),
        status: r.status,
        sources: r.sources || [],
        confidence: r.confidence,
      });
    }
  }

  // 全空：所有模型都 unknown
  if (candidates.length === 0) {
    // model_summary 保持简短（报告小字用）；reason 保留模型写的详细原因（试了什么/为何失败/建议查哪）
    const summary = (modelResults || []).map(r => `${r.modelName || r.modelId}: 未找到`).join('；') || '无模型参与';
    const detailed = (modelResults || [])
      .filter(r => r.reason && r.reason.trim() && !/^未找到$/.test(r.reason.trim()))
      .map(r => `【${r.modelName || r.modelId}】${r.reason.trim()}`)
      .join('\n');
    return {
      status: 'unknown',
      value: '待补充',
      reason: detailed || summary,
      sources: [],
      model_summary: summary,
      participants: (modelResults || []).map(r => ({ name: r.modelName || r.modelId, status: 'unknown', value: '' })),
    };
  }

  // 只有一个候选 → 直接返回
  if (candidates.length === 1) {
    const c = candidates[0];
    return {
      status: c.status === 'known' ? 'agree' : 'filled',
      value: c.value,
      reason: c.status === 'known' ? '仅已知值' : `仅 ${c.name} 提供有效结果`,
      sources: c.sources,
      model_summary: `${c.name}: ${truncate(c.value, 60)}`,
      participants: candidates.map(x => ({ name: x.name, status: x.status, value: x.value })),
    };
  }

  // 两两比对所有候选是否都意思相近
  let allAgree = true;
  for (let i = 0; i < candidates.length && allAgree; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      if (!nearlyEqual(fieldKey, candidates[i].value, candidates[j].value)) {
        allAgree = false;
        break;
      }
    }
  }

  // 合并 sources（去重）
  const allSources = [];
  const seenUrl = new Set();
  for (const c of candidates) {
    for (const s of (c.sources || [])) {
      if (s?.url && !seenUrl.has(s.url)) { seenUrl.add(s.url); allSources.push(s); }
    }
  }

  if (allAgree) {
    // agree：随机选一个有 source 的，没有就第 0 个
    const primary = candidates.find(c => c.sources?.length) || candidates[0];
    const summary = candidates.map(c => `${c.name} ✓`).join('  ');
    const hasKnown = candidates.some(c => c.status === 'known');
    return {
      status: hasKnown ? 'agree' : 'filled',
      value: primary.value,
      reason: `${candidates.length} 个来源一致（含${hasKnown ? '已知值与' : ''}${candidates.length - (hasKnown?1:0)} 个模型）`,
      sources: allSources,
      model_summary: summary,
      participants: candidates.map(x => ({ name: x.name, status: x.status, value: x.value })),
    };
  }

  // conflict：按名称排序拼分号
  const sorted = candidates.slice().sort((a, b) => a.name.localeCompare(b.name));
  const value = sorted.map(c => `${c.value}(from ${c.name})`).join('; ');
  const values = sorted.map(c => c.value);
  const summary = sorted.map(c => `${c.name} ✗`).join('  ');
  return {
    status: 'conflict',
    value,
    values,
    reason: `${sorted.length} 个来源结果不一致，已并列保留待人工校验`,
    sources: allSources,
    model_summary: summary,
    participants: sorted.map(x => ({ name: x.name, status: x.status, value: x.value })),
  };
}

function truncate(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// 暴露用于测试
export const _internal = { nearlyEqual, textSim, parseFirstNumber };
