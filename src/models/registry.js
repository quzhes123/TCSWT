// 模型注册中心：从 db 加载已启用的模型，按 provider 路由到对应 driver
import * as db from '../db.js';
import { AnthropicDriver } from './driver-anthropic.js';
import { OpenAIDriver } from './driver-openai.js';

const DRIVER_MAP = {
  anthropic: AnthropicDriver,
  openai: OpenAIDriver,
  // openai 协议兼容系（都走 OpenAIDriver）
  gpt: OpenAIDriver,
  deepseek: OpenAIDriver,
  qwen: OpenAIDriver,
  moonshot: OpenAIDriver,
  wenxin: OpenAIDriver,
  custom: OpenAIDriver,   // 默认猜 OpenAI 兼容
};

let _registry = null;

/** 加载所有已启用的模型为 driver 实例（key = model id） */
export function loadRegistry() {
  const models = db.listModels({ enabledOnly: true });
  const map = new Map();
  for (const m of models) {
    const full = db.getModelWithSecret(m.id);  // 拿到含明文 api_key
    if (!full) continue;
    const DriverCls = DRIVER_MAP[full.provider] || OpenAIDriver;
    map.set(full.id, new DriverCls(full));
  }
  _registry = map;
  return _registry;
}

/** 取单个 driver 实例（按 model id） */
export function getDriver(modelId) {
  if (!_registry) loadRegistry();
  return _registry.get(modelId);
}

/** 全部已启用的 driver 实例 */
export function getAllDrivers() {
  if (!_registry) loadRegistry();
  return Array.from(_registry.values());
}

/** 重载注册表（配置变化后调用） */
export function reloadRegistry() {
  _registry = null;
  return loadRegistry();
}
