import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Encryption for unrevealed server seeds at rest (AES-256-GCM).
 * Format: [version 0x01][12-byte IV][16-byte auth tag][ciphertext].
 * The key comes from FAIRNESS_KEY (64 hex chars). In production it lives in a secret manager / KMS,
 * never in the repo, and not in the database: a DB leak alone must not reveal upcoming outcomes.
 */
const VERSION = 0x01;

export function loadFairnessKey(hex = process.env.FAIRNESS_KEY): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("FAIRNESS_KEY must be set to 64 hex characters (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptSeed(seed: string, key: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(seed, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptSeed(blob: Buffer, key: Buffer): string {
  if (blob[0] !== VERSION) throw new Error("Unknown seed encryption version");
  const iv = blob.subarray(1, 13);
  const tag = blob.subarray(13, 29);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(29)), decipher.final()]).toString("utf8");
}
