import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for small secrets at rest (server seeds, 2FA secrets).
 * Format: [version 0x01][12-byte IV][16-byte auth tag][ciphertext]. Tampering is detected.
 */
const VERSION = 0x01;

export function loadKey(name: string, hex = process.env[name]): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`${name} must be set to 64 hex characters (32 bytes)`);
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  if (blob[0] !== VERSION) throw new Error("Unknown encryption version");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(1, 13));
  decipher.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8");
}
