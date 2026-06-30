// merger.js 单元测试
import assert from 'node:assert/strict';
import { mergeMultiModel, _internal } from '../src/merger.js';

const { nearlyEqual, textSim, parseFirstNumber } = _internal;

console.log('=== merger.js 单元测试 ===\n');

// 1. parseFirstNumber
assert.equal(parseFirstNumber('1000万'), 10000000);
assert.equal(parseFirstNumber('3.5亿'), 350000000);
assert.equal(parseFirstNumber('45%'), 0.45);
assert.equal(parseFirstNumber('￥1,234.56'), 1234.56);
console.log('✓ parseFirstNumber');

// 2. textSim
assert.ok(textSim('马上消费金融', '马上消费金融股份有限公司') > 0.6);
assert.ok(textSim('信也科技', '拍拍贷') < 0.3);
console.log('✓ textSim');

// 3. nearlyEqual 数值
assert.ok(nearlyEqual('q2_revenue_estimate', '1000万', '1050万'));     // 5% 差
assert.ok(!nearlyEqual('q2_revenue_estimate', '1000万', '1200万'));    // 20% 超阈值
console.log('✓ nearlyEqual 数值');

// 4. nearlyEqual 文本
assert.ok(nearlyEqual('key_decision_maker', 'CEO李铁铮', 'CEO 李铁铮（在任）'));
assert.ok(!nearlyEqual('key_decision_maker', 'CEO李铁铮', 'CEO王五'));
console.log('✓ nearlyEqual 文本');

// 5. 全空 → unknown
{
  const r = mergeMultiModel({
    fieldKey: 'some_field',
    knownValue: null,
    modelResults: [
      { modelId: 'gpt', modelName: 'GPT-4', status: 'unknown', value: '' },
      { modelId: 'claude', modelName: 'Claude', status: 'unknown', value: '' },
    ],
  });
  assert.equal(r.status, 'unknown');
  assert.equal(r.value, '待补充');
  console.log('✓ 全空 → unknown');
}

// 6. 单一候选
{
  const r = mergeMultiModel({
    fieldKey: 'app_name',
    knownValue: null,
    modelResults: [
      { modelId: 'gpt', modelName: 'GPT-4', status: 'filled', value: '马上金融APP', sources: [{url:'x'}] },
    ],
  });
  assert.equal(r.status, 'filled');
  assert.equal(r.value, '马上金融APP');
  console.log('✓ 单一候选');
}

// 7. 多模型一致（数值）
{
  const r = mergeMultiModel({
    fieldKey: 'q2_revenue_estimate',
    knownValue: null,
    modelResults: [
      { modelId: 'gpt', modelName: 'GPT-4', status: 'filled', value: '1000万', sources: [{url:'a'}] },
      { modelId: 'claude', modelName: 'Claude', status: 'filled', value: '1050万', sources: [{url:'b'}] },
      { modelId: 'ds', modelName: 'DeepSeek', status: 'filled', value: '1020万', sources: [] },
    ],
  });
  assert.equal(r.status, 'filled');
  assert.ok(r.model_summary.includes('✓'));
  console.log('✓ 多模型一致（数值）');
}

// 8. 多模型一致（文本）
{
  const r = mergeMultiModel({
    fieldKey: 'key_decision_maker',
    knownValue: null,
    modelResults: [
      { modelId: 'gpt', modelName: 'GPT-4', status: 'filled', value: 'CEO李铁铮', sources: [] },
      { modelId: 'claude', modelName: 'Claude', status: 'filled', value: 'CEO李铁铮（2023年3月至今）', sources: [] },
    ],
  });
  assert.equal(r.status, 'filled');
  assert.ok(r.model_summary.includes('✓'));
  console.log('✓ 多模型一致（文本）');
}

// 9. 已知值与模型一致
{
  const r = mergeMultiModel({
    fieldKey: 'customer_level',
    knownValue: 'A',
    modelResults: [
      { modelId: 'gpt', modelName: 'GPT-4', status: 'filled', value: 'A', sources: [] },
    ],
  });
  assert.equal(r.status, 'agree');
  assert.equal(r.value, 'A');
  assert.ok(r.model_summary.includes('已知'));
  console.log('✓ 已知值与模型一致');
}

// 10. 已知值与模型冲突
{
  const r = mergeMultiModel({
    fieldKey: 'region',
    knownValue: '北京',
    modelResults: [
      { modelId: 'gpt', modelName: 'GPT-4', status: 'filled', value: '全国', sources: [] },
    ],
  });
  assert.equal(r.status, 'conflict');
  assert.ok(r.value.includes('北京') && r.value.includes('全国'));
  assert.ok(r.model_summary.includes('✗'));
  console.log('✓ 已知值与模型冲突');
}

// 11. 多模型冲突
{
  const r = mergeMultiModel({
    fieldKey: 'q2_revenue_estimate',
    knownValue: null,
    modelResults: [
      { modelId: 'gpt', modelName: 'GPT-4', status: 'filled', value: '1000万', sources: [] },
      { modelId: 'claude', modelName: 'Claude', status: 'filled', value: '2000万', sources: [] },
    ],
  });
  assert.equal(r.status, 'conflict');
  assert.ok(r.value.includes('1000万') && r.value.includes('2000万'));
  assert.ok(r.value.includes('from'));
  assert.ok(r.values && r.values.length === 2);
  console.log('✓ 多模型冲突');
}

// 12. 已知值 + 2 模型一致但与已知值冲突 → 3 路冲突
{
  const r = mergeMultiModel({
    fieldKey: 'business_line',
    knownValue: '零售',
    modelResults: [
      { modelId: 'gpt', modelName: 'GPT-4', status: 'filled', value: '金融科技', sources: [] },
      { modelId: 'claude', modelName: 'Claude', status: 'filled', value: '金融科技', sources: [] },
    ],
  });
  assert.equal(r.status, 'conflict');
  // 已知 vs 金融科技（两个一样合成一个）→ 2 个候选不同
  assert.equal(r.participants.length, 3);
  console.log('✓ 已知值 + 2 模型一致但与已知值冲突');
}

console.log('\n✅ 所有测试通过\n');
