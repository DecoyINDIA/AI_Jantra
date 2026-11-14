import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  encryptSecret,
  decryptSecret,
  DecryptionError,
  SecretsKeyMissingError,
} from "./encryption.js";
import { config } from "../config.js";

describe("AES-256-GCM Encryption (T-018)", () => {
  const testKey = randomBytes(32);

  it("encrypts and decrypts string data round-trip", () => {
    const secret = JSON.stringify({ STRIPE_API_KEY: "sk_live_1234567890abcdef" });
    const encrypted = encryptSecret(secret, testKey);
    assert.match(encrypted, /^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);

    const decrypted = decryptSecret(encrypted, testKey);
    assert.equal(decrypted, secret);
  });

  it("fails closed on decryption with wrong key", () => {
    const wrongKey = randomBytes(32);
    const secret = "super-secret-shopify-token";
    const encrypted = encryptSecret(secret, testKey);

    assert.throws(
      () => decryptSecret(encrypted, wrongKey),
      (err: unknown) => err instanceof DecryptionError,
    );
  });

  it("fails closed on tampered ciphertext or auth tag", () => {
    const secret = "sensitive-credentials";
    const encrypted = encryptSecret(secret, testKey);
    const parts = encrypted.split(":");

    // Tamper auth tag
    const badTag = parts[2]!.replace(/^./, parts[2]![0] === "a" ? "b" : "a");
    const tampered = `${parts[0]}:${parts[1]}:${badTag}:${parts[3]}`;

    assert.throws(
      () => decryptSecret(tampered, testKey),
      (err: unknown) => err instanceof DecryptionError,
    );
  });

  it("fails closed when JANTRA_SECRETS_KEY is missing", () => {
    const originalKey = config.secretsKey;
    try {
      (config as any).secretsKey = "";
      assert.throws(
        () => encryptSecret("hello"),
        (err: unknown) => err instanceof SecretsKeyMissingError,
      );
    } finally {
      (config as any).secretsKey = originalKey;
    }
  });
});
