import crypto from "node:crypto";
import { canonicalizePayload } from "./verify.js";
import type { LicenseEnvelope, LicensePayload } from "./types.js";

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
