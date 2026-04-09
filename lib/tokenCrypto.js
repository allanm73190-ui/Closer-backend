'use strict';
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KEY = Buffer.from(
  (process.env.TOKEN_ENCRYPTION_KEY || '').padEnd(64, '0').slice(0, 64),
  'hex'
);

function encrypt(plaintext) {
  if (!plaintext) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, KEY, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('hex'), enc.toString('hex'), tag.toString('hex')].join(':');
}

function decrypt(ciphertext) {
  if (!ciphertext) return null;
  try {
    const [ivHex, encHex, tagHex] = ciphertext.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGO, KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

module.exports = { encrypt, decrypt };
