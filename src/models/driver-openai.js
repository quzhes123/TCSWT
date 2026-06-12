// OpenAI Chat Completions 协议驱动（兼容 GPT-4 / DeepSeek / Qwen / Moonshot / 文心兼容版 等）
// 把 Anthropic 风格的 tool_use/tool_result 双向翻译成 OpenAI 的 tool_calls/role:tool
import { BaseDriver } from './driver-base.js';

export class OpenAIDriver extends BaseDriver {
  async chat({ system, tools, messages, toolChoice, maxTokens = 2000 }) {
    const oaMessages = [];
    if (system) oaMessages.push({ role: 'system', content: system });

    // 把统一格式翻译为 OpenAI 格式：
    // - assistant 含 tool_use → { role:'assistant', content:..., tool_calls:[{id,type:'function',function:{name,arguments:JSON}}] }
    // - user 含 tool_result block 数组 → 每条拆成 { role:'tool', tool_call_id, content }
    for (const m of messages) {
      if (m.role === 'assistant' && Array.isArray(m.content)) {
        const toolCalls = [];
        const textParts = [];
        for (const b of m.content) {
          if (b.type === 'tool_use') {
            toolCalls.push({
              id: b.id,
              type: 'function',
              function: { name: b.name, arguments: JSON.stringify(b.input || {}) },
            });
          } else if (b.type === 'text') {
            textParts.push(b.text || '');
          }
        }
        const out = { role: 'assistant', content: textParts.join('\n') || null };
        if (toolCalls.length) out.tool_calls = toolCalls;
        oaMessages.push(out);
      } else if (m.role === 'user' && Array.isArray(m.content)) {
        // 仅 tool_result 数组的情况：拆成多条 role:'tool'
        let allToolResults = m.content.every(b => b && b.type === 'tool_result');
        if (allToolResults) {
          for (const b of m.content) {
            oaMessages.push({ role: 'tool', tool_call_id: b.tool_use_id, content: typeof b.content === 'string' ? b.content : JSON.stringify(b.content) });
          }
        } else {
          // 混合内容：拼成纯文本（保守做法，研究循环我们不会走到这分支）
          oaMessages.push({ role: 'user', content: m.content.map(b => b.type === 'text' ? (b.text || '') : '').join('\n') });
        }
      } else {
        // 普通字符串内容
        oaMessages.push({ role: m.role, content: m.content });
      }
    }

    const body = {
      model: this.cfg.identifier,
      messages: oaMessages,
      temperature: 0,
      max_tokens: maxTokens,
    };
    if (tools && tools.length) {
      body.tools = tools.map(t => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
      }));
      // 转 toolChoice
      if (toolChoice?.type === 'tool' && toolChoice.name) {
        body.tool_choice = { type: 'function', function: { name: toolChoice.name } };
      } else if (toolChoice?.type === 'auto') {
        body.tool_choice = 'auto';
      }
    }

    const resp = await this._fetchJSON(this.cfg.api_url, body);
    const choice = resp.choices?.[0];
    const msg = choice?.message || {};

    // 翻译回统一格式
    const toolUses = [];
    for (const tc of (msg.tool_calls || [])) {
      let input = {};
      try { input = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {}; } catch { input = {}; }
      toolUses.push({ id: tc.id, name: tc.function?.name || '', input });
    }
    const text = typeof msg.content === 'string' ? msg.content : '';

    // 把 OpenAI 的 message 翻成统一 assistantContent（供研究循环原样回传）
    const assistantContent = [];
    if (text) assistantContent.push({ type: 'text', text });
    for (const tu of toolUses) {
      assistantContent.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }

    return {
      toolUses,
      text,
      stopReason: choice?.finish_reason || '',
      raw: resp,
      assistantContent,
    };
  }
}
