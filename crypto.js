'use strict';
const crypto = require('crypto');

// Derive a 32-byte key from the env variable using scrypt
let _key = null;
function getKey() {
  if (_key) return _key;
  const raw = process.env.ENCRYPTION_KEY || 'fallback-key-change-in-production!';
  _key = crypto.scryptSync(raw, 'mad-sailors-salt-v1', 32);
  return _key;
}

/**
 * Encrypt a plaintext string → "iv:authTag:ciphertext" (all hex)
 * Returns null if value is null/empty.
 */
function encrypt(plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', getKey(), iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), tag.toString('hex'), enc.toString('hex')].join(':');
}

/**
 * Decrypt "iv:authTag:ciphertext" → plaintext string
 * Returns null if value is null/empty/invalid.
 */
function decrypt(payload) {
  if (!payload) return null;
  try {
    const [ivH, tagH, dataH] = payload.split(':');
    if (!ivH || !tagH || !dataH) return null;
    const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(ivH, 'hex'));
    decipher.setAuthTag(Buffer.from(tagH, 'hex'));
    return decipher.update(dataH, 'hex', 'utf8') + decipher.final('utf8');
  } catch {
    return null; // tampered or wrong key
  }
}

module.exports = { encrypt, decrypt };
