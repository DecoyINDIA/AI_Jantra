import crypto from "node:crypto";
import fs from "node:fs";
import { canonicalizePayload } from "./verify.js";
import type { LicenseEnvelope, LicensePayload } from "./types.js";

export function resolvePrivateKey(keyOption?: string | boolean): string {
  if (typeof keyOption === "string" && keyOption.trim()) {
    const trimmed = keyOption.trim();
    if (trimmed.includes("-----BEGIN") || trimmed.includes("PRIVATE KEY")) {
      return trimmed;
    }
    if (fs.existsSync(trimmed)) {
      return fs.readFileSync(trimmed, "utf8");
    }
    throw new Error(`Private key file not found: ${trimmed}`);
  }
  throw new Error(
    "License issuance requires an Ed25519 private key. Provide an explicit key path or PEM string.",
  );
}

export function createLicenseToken(
  payload: LicensePayload,
  privateKeyPemOrKey: string | Buffer | crypto.KeyObject,
): string {
  const canonicalBytes = Buffer.from(canonicalizePayload(payload), "utf8");
  const signature = crypto.sign(null, canonicalBytes, privateKeyPemOrKey);
  const envelope: LicenseEnvelope = {
    payload,
    signature: signature.toString("base64"),
  };
  return Buffer.from(JSON.stringify(envelope), "utf8").toString("base64");
}

export function generateLicenseKeyPair(): {
  publicKey: string;
  privateKey: string;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  return { publicKey, privateKey };
}
