// Anthropic 协议驱动：直接调 /v1/messages HTTP API（不依赖 SDK，以便兼容任意 URL/认证组合）
import { BaseDriver } from './driver-base.js';

export class AnthropicDriver extends BaseDriver {
  async chat({ system, tools, messages, toolChoice, maxTokens = 2000 }) {
    const body = {
      model: this.cfg.identifier || 'claude-opus-4-8',
      max_tokens: maxTokens,
      temperature: 0,
      messages,
    };
    if (system) body.system = system;
    if (tools && tools.length) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;

    // Anthropic 默认要求 anthropic-version 头；如 custom_headers 已带就不重复设
    const extra = {};
    if (!this.cfg.custom_headers || !Object.keys(this.cfg.custom_headers).some(k => k.toLowerCase() === 'anthropic-version')) {
      extra['anthropic-version'] = '2023-06-01';
    }

    const resp = await this._fetchJSON(this.cfg.api_url, body, extra);

    // 提取 toolUses + text
    const toolUses = [];
    const textParts = [];
    for (const block of (resp.content || [])) {
      if (block.type === 'tool_use') {
        toolUses.push({ id: block.id, name: block.name, input: block.input || {} });
      } else if (block.type === 'text') {
        textParts.push(block.text || '');
      }
    }
    return {
      toolUses,
      text: textParts.join('\n'),
      stopReason: resp.stop_reason || '',
      raw: resp,
      // assistant 回复的 content blocks 原样保留，研究循环要把它原样塞回 messages
      assistantContent: resp.content || [],
    };
  }
}
