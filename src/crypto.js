// AES-256-GCM 对称加密：用于持久化 API key
// 设计目标：「页面配置即用」—— 不需要管理外部密钥文件,跨环境/重启零运维。
// 主密钥来源（按优先级）：
//   1. process.env.MODEL_KEY_SECRET — 高安全部署可选,显式指定主密钥
//   2. 代码内常量派生 — 默认。SHA-256 派生一个固定密钥,所有环境一致,db.json 跨机器可解
//
// 注意：方式 2 的安全性等价于"db.json 文件本身的访问控制"——
//   - db.json 不入 git(.gitignore 已配)
//   - 不应公开发布 db.json 文件
//   - API 列表/详情接口绝不回传 api_key 字段(maskHeaders 已处理)
//   生产环境若有更高安全要求,设 MODEL_KEY_SECRET 环境变量即可。
import crypto from 'node:crypto';

// 内置派生根：固定字符串。修改它会让历史所有 db.json 解密失败,谨慎。
const _BUILT_IN = 'tcswt::shangwutong::default-mk::v1';

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let _key = null;

/** 取主密钥（32 字节）。优先 env，否则用代码常量派生。 */
export function getKey() {
  if (_key) return _key;
  const fromEnv = (process.env.MODEL_KEY_SECRET || '').trim();
  if (fromEnv) {
    const buf = decodeKeyString(fromEnv);
    if (buf && buf.length === 32) { _key = buf; return _key; }
  }
  // 派生：SHA-256 把固定字符串映射成 32 字节
  _key = crypto.createHash('sha256').update(_BUILT_IN).digest();
  return _key;
}

function decodeKeyString(s) {
  try {
    const b = Buffer.from(s, 'base64');
    if (b.length === 32) return b;
  } catch {}
  try {
    if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  } catch {}
  return null;
}

/** 加密：明文 → 'v1:base64(iv|tag|cipher)' */
export function encrypt(plain) {
  if (plain == null || plain === '') return '';
  const key = getKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
}

/** 解密：失败返回 '' 不抛 */
export function decrypt(payload) {
  if (!payload) return '';
  const s = String(payload);
  if (!s.startsWith('v1:')) return '';
  try {
    const buf = Buffer.from(s.slice(3), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + 16);
    const data = buf.subarray(IV_LEN + 16);
    const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

/** 用于前端展示：把任何已加密值替换为定长星号，永不回传明文/密文 */
export function masked(payload) {
  return payload ? '••••••••' : '';
}
