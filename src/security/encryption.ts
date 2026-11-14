import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "../config.js";

export class DecryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecryptionError";
  }
}

export class SecretsKeyMissingError extends Error {
  constructor(message = "JANTRA_SECRETS_KEY is not configured. Required for encrypted credentials.") {
    super(message);
    this.name = "SecretsKeyMissingError";
  }
}

/**
 * Derives a 32-byte key buffer from JANTRA_SECRETS_KEY.
 * Accepts 64 hex characters, a 32-byte string, or derives 32 bytes via SHA-256.
 */
export function getSecretsKey(): Buffer {
  const raw = config.secretsKey;
  if (!raw || !raw.trim()) {
    throw new SecretsKeyMissingError();
  }
  const trimmed = raw.trim();
  if (trimmed.length === 64 && /^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }
  if (Buffer.byteLength(trimmed, "utf8") === 32) {
    return Buffer.from(trimmed, "utf8");
  }
  return createHash("sha256").update(trimmed).digest();
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Format: v1:<ivHex>:<tagHex>:<ciphertextHex>
 */
export function encryptSecret(plaintext: string, key?: Buffer): string {
  const secretsKey = key ?? getSecretsKey();
  const iv = randomBytes(12); // 96-bit IV
  const cipher = createCipheriv("aes-256-gcm", secretsKey, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts AES-256-GCM payload.
 * Throws DecryptionError if authentication tag fails or data is invalid.
 */
export function decryptSecret(ciphertextBlob: string, key?: Buffer): string {
  const secretsKey = key ?? getSecretsKey();
  const parts = ciphertextBlob.split(":");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new DecryptionError("Invalid encrypted payload format.");
  }
  const [, ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || !dataHex) {
    throw new DecryptionError("Encrypted payload has missing components.");
  }
  try {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const data = Buffer.from(dataHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", secretsKey, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err: any) {
    throw new DecryptionError(`Failed to decrypt secret: ${err.message}`);
  }
}
