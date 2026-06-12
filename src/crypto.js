// AES-256-GCM 对称加密：用于持久化 API key
// 加密 key 保存在 .env.local（不入 git）；首次启动若缺失自动生成
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_LOCAL = path.resolve(__dirname, '..', '.env.local');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let _key = null;

/** 取/造主密钥（32 字节）。从 process.env.MODEL_KEY_SECRET 读，缺则生成并写 .env.local */
export function getKey() {
  if (_key) return _key;
  const fromEnv = (process.env.MODEL_KEY_SECRET || '').trim();
  if (fromEnv) {
    const buf = decodeKeyString(fromEnv);
    if (buf && buf.length === 32) { _key = buf; return _key; }
  }
  // 生成新 key 并写 .env.local（追加，不覆盖既有内容）
  const buf = crypto.randomBytes(32);
  const line = 'MODEL_KEY_SECRET=' + buf.toString('base64') + '\n';
  let existing = '';
  if (fs.existsSync(ENV_LOCAL)) existing = fs.readFileSync(ENV_LOCAL, 'utf8');
  if (!/^MODEL_KEY_SECRET=/m.test(existing)) {
    fs.writeFileSync(ENV_LOCAL, existing + (existing.endsWith('\n') || existing === '' ? '' : '\n') + line);
  }
  process.env.MODEL_KEY_SECRET = buf.toString('base64');
  _key = buf;
  return _key;
}

function decodeKeyString(s) {
  // 支持 base64 或 hex
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
