import crypto from "node:crypto";
import fs from "node:fs";
import { canonicalizePayload } from "./verify.js";
import type { LicenseEnvelope, LicensePayload } from "./types.js";

export function resolvePrivateKey(keyOption?: string | boolean): string {
  if (typeof keyOption === "string" && keyOption.trim()) {
    const keyPath = keyOption.trim();
    if (!fs.existsSync(keyPath)) {
      throw new Error(`Private key file not found: ${keyPath}`);
    }
    return fs.readFileSync(keyPath, "utf8");
  }
  const envKey = process.env.JANTRA_LICENSE_PRIVATE_KEY;
  if (envKey && envKey.trim()) {
    return envKey.trim();
  }
  throw new Error(
    "License issuance requires an Ed25519 private key. Provide --key <path> or set the JANTRA_LICENSE_PRIVATE_KEY environment variable.",
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
