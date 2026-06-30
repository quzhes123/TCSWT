// 模型驱动抽象：把不同厂商 API 统一成 chat({system, tools, messages}) → {toolUses, text, stopReason}
// 工具协议参照 Anthropic 的 tool_use 形态(每个 tool: {name, input_schema})；
// 各 driver 内部把它翻译成自家协议（OpenAI 的 tools[].function、Google 的 functionDeclarations 等）。

/** @typedef {{ name: string, description: string, input_schema: object }} ToolSpec */
/** @typedef {{ id: string, name: string, input: object }} ToolUse */

export class BaseDriver {
  /**
   * @param {object} cfg - 来自 db.models 的完整配置（含明文 api_key，由 registry 注入）
   */
  constructor(cfg) {
    this.cfg = cfg;
  }

  /** 模型显示名（前端展示、合并时区分来源用） */
  get displayName() {
    return this.cfg.name || this.cfg.identifier || this.cfg.id;
  }

  /** 配置 id（合并时按此排序保证稳定输出） */
  get id() {
    return this.cfg.id;
  }

  /**
   * 统一的 chat 入口。子类必须实现。
   * @param {object} args
   * @param {string} args.system
   * @param {ToolSpec[]} [args.tools]
   * @param {Array} args.messages - [{role:'user'|'assistant', content: string | block[]}]
   *   block 形如 {type:'tool_result', tool_use_id, content: string}
   * @param {object} [args.toolChoice] - {type:'auto'|'tool', name?}
   * @param {number} [args.maxTokens]
   * @returns {Promise<{toolUses: ToolUse[], text: string, stopReason: string, raw: any}>}
   */
  async chat(_args) { throw new Error('chat() not implemented'); }

  /**
   * 简单的探活 ping，用于「连通性测试」按钮。子类可重写。
   * 默认实现：发一句 "OK?"，期望模型返回非空文本。
   * @returns {Promise<{ok:boolean, latencyMs:number, error?:string, sample?:string}>}
   */
  async ping() {
    const t0 = Date.now();
    try {
      const r = await this.chat({
        system: '你是一个测试助手。请用中文回复一个字"是"。',
        messages: [{ role: 'user', content: '说一个字' }],
        maxTokens: 32,
      });
      const text = (r.text || '').trim() || (r.toolUses?.length ? '[tool_use]' : '');
      if (!text) return { ok: false, latencyMs: Date.now() - t0, error: '空响应', sample: '' };
      return { ok: true, latencyMs: Date.now() - t0, sample: text.slice(0, 60) };
    } catch (e) {
      return { ok: false, latencyMs: Date.now() - t0, error: String(e?.message || e).slice(0, 300) };
    }
  }

  /** 通用 fetch 包装：超时 / 自定义 headers / 错误规整 */
  async _fetchJSON(url, body, extraHeaders = {}) {
    const ctrl = new AbortController();
    const timeoutMs = (this.cfg.timeout || 120) * 1000;
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json', ...this._authHeaders(), ...(this.cfg.custom_headers || {}), ...extraHeaders };
      const r = await fetch(url, {
        method: 'POST',
        signal: ctrl.signal,
        headers,
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
      const txt = await r.text();
      if (!r.ok) {
        throw new Error(`HTTP ${r.status} ${txt.slice(0, 200)}`);
      }
      try { return JSON.parse(txt); } catch { throw new Error('响应非 JSON: ' + txt.slice(0, 200)); }
    } finally {
      clearTimeout(t);
    }
  }

  /** 根据 auth_type 生成认证 header（custom_header 优先级最高，由 cfg.custom_headers 直接提供） */
  _authHeaders() {
    const k = this.cfg.api_key;
    if (!k) return {};
    switch (this.cfg.auth_type) {
      case 'bearer':         return { Authorization: 'Bearer ' + k };
      case 'api_key_header': return { 'x-api-key': k };
      case 'custom_header':  return {};   // 用户已在 custom_headers 自填
      case 'none':           return {};
      default:               return { Authorization: 'Bearer ' + k };
    }
  }
}
