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

/** True when a secrets key is configured (no throw). */
export function hasSecretsKey(): boolean {
  return Boolean(config.secretsKey && config.secretsKey.trim());
}

/**
 * Associated data that binds a stored credential to its record. GCM
 * authenticates it, so a blob copied into another tenant's or connector's row
 * fails to decrypt instead of silently handing over someone else's secret.
 */
export function credentialAad(clientId: string, connector: string): string {
  return `jantra-credential\u0000${clientId}\u0000${connector}`;
}

/** v1 blobs predate record binding; stores re-encrypt them as v2 on sight. */
export function isLegacySecret(blob: string): boolean {
  return blob.startsWith("v1:");
}

/**
 * Encrypts plaintext using AES-256-GCM.
 * Format: v2:<ivHex>:<tagHex>:<ciphertextHex> when bound to `aad`
 * (credentials always are), v1:... otherwise.
 */
export function encryptSecret(plaintext: string, key?: Buffer, aad?: string): string {
  const secretsKey = key ?? getSecretsKey();
  const iv = randomBytes(12); // 96-bit IV
  const cipher = createCipheriv("aes-256-gcm", secretsKey, iv);
  if (aad !== undefined) cipher.setAAD(Buffer.from(aad, "utf8"));
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const version = aad !== undefined ? "v2" : "v1";
  return `${version}:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

/**
 * Decrypts AES-256-GCM payload.
 * Throws DecryptionError if authentication tag fails or data is invalid.
 */
export function decryptSecret(ciphertextBlob: string, key?: Buffer, aad?: string): string {
  const secretsKey = key ?? getSecretsKey();
  const parts = ciphertextBlob.split(":");
  if (parts.length !== 4 || (parts[0] !== "v1" && parts[0] !== "v2")) {
    throw new DecryptionError("Invalid encrypted payload format.");
  }
  const bound = parts[0] === "v2";
  if (bound && aad === undefined) {
    throw new DecryptionError("Bound secret requires its record context to decrypt.");
  }
  const [, ivHex, tagHex, dataHex] = parts;
  if (!ivHex || !tagHex || !dataHex) {
    throw new DecryptionError("Encrypted payload has missing components.");
  }
  // Enforce the exact sizes encryptSecret writes. Without authTagLength,
  // Node accepts GCM tags as short as 4 bytes, which makes forging a
  // ciphertext about 2^32 times cheaper.
  if (!/^[0-9a-f]{24}$/i.test(ivHex) || !/^[0-9a-f]{32}$/i.test(tagHex) || !/^(?:[0-9a-f]{2})*$/i.test(dataHex)) {
    throw new DecryptionError("Encrypted payload has malformed components.");
  }
  try {
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const data = Buffer.from(dataHex, "hex");
    const decipher = createDecipheriv("aes-256-gcm", secretsKey, iv, { authTagLength: 16 });
    // v1 has no associated data; v2 must match the record it is read from.
    if (bound) decipher.setAAD(Buffer.from(aad as string, "utf8"));
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
    return decrypted.toString("utf8");
  } catch (err: any) {
    throw new DecryptionError(`Failed to decrypt secret: ${err.message}`);
  }
}
