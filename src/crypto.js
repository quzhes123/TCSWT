// AES-256-GCM 对称加密：用于持久化 API key
// 加密 key 来源（按优先级）：
//   1. process.env.MODEL_KEY_SECRET — 优先用环境变量（适合云部署/容器）
//   2. data/.secret 文件 — 启动时若无此文件则生成；data 目录通常挂载持久卷
//   .env.local 已废弃（不会随仓库同步,也不在持久化路径,容易导致 key 漂移）
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECRET_FILE = path.resolve(__dirname, '..', 'data', '.secret');
// 兼容旧路径：若仍存在 .env.local 且环境变量没读到 key,从中迁移过来一次
const LEGACY_ENV_LOCAL = path.resolve(__dirname, '..', '.env.local');

const ALGO = 'aes-256-gcm';
const IV_LEN = 12;

let _key = null;

/** 取/造主密钥（32 字节）。优先级：env > data/.secret > 自动生成（写到 data/.secret） */
export function getKey() {
  if (_key) return _key;

  // 1. 环境变量
  const fromEnv = (process.env.MODEL_KEY_SECRET || '').trim();
  if (fromEnv) {
    const buf = decodeKeyString(fromEnv);
    if (buf && buf.length === 32) { _key = buf; return _key; }
  }

  // 2. data/.secret 文件
  if (fs.existsSync(SECRET_FILE)) {
    try {
      const content = fs.readFileSync(SECRET_FILE, 'utf8').trim();
      const buf = decodeKeyString(content);
      if (buf && buf.length === 32) {
        _key = buf;
        process.env.MODEL_KEY_SECRET = content;  // 同步到 env,其他子进程也能用
        return _key;
      }
    } catch {}
  }

  // 3. 兼容：从旧 .env.local 迁移
  if (fs.existsSync(LEGACY_ENV_LOCAL)) {
    try {
      const content = fs.readFileSync(LEGACY_ENV_LOCAL, 'utf8');
      const m = content.match(/^MODEL_KEY_SECRET=(.+)$/m);
      if (m) {
        const buf = decodeKeyString(m[1].trim());
        if (buf && buf.length === 32) {
          // 把 key 迁移到新位置
          fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
          fs.writeFileSync(SECRET_FILE, m[1].trim() + '\n', { mode: 0o600 });
          _key = buf;
          process.env.MODEL_KEY_SECRET = m[1].trim();
          return _key;
        }
      }
    } catch {}
  }

  // 4. 都没有：生成新 key 并写到 data/.secret（不写 .env.local）
  const buf = crypto.randomBytes(32);
  const b64 = buf.toString('base64');
  fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
  fs.writeFileSync(SECRET_FILE, b64 + '\n', { mode: 0o600 });
  process.env.MODEL_KEY_SECRET = b64;
  _key = buf;
  console.log('[crypto] 新生成加密主密钥 → ' + SECRET_FILE);
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
