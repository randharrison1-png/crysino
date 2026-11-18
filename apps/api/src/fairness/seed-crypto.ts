import { decrypt, encrypt, loadKey } from "../lib/secretbox.js";

/**
 * Encryption for unrevealed server seeds at rest. The key (FAIRNESS_KEY) lives in a secret
 * manager in production — never in the repo or the database, so a DB leak alone can't reveal
 * upcoming outcomes.
 */
export const loadFairnessKey = (hex = process.env.FAIRNESS_KEY): Buffer => loadKey("FAIRNESS_KEY", hex);
export const encryptSeed = encrypt;
export const decryptSeed = decrypt;
