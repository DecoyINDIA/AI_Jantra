import crypto from "node:crypto";
import { getLicensePublicKey } from "./keys.js";
import type { LicensePayload, LicenseStatus, LicenseVerificationResult } from "./types.js";

export function canonicalizePayload(payload: LicensePayload): string {
  const sorted: Record<string, string> = {
    expiresAt: String(payload.expiresAt ?? ""),
    issuedAt: String(payload.issuedAt ?? ""),
    licensee: String(payload.licensee ?? ""),
    plan: String(payload.plan ?? ""),
  };
  return JSON.stringify(sorted);
}

interface ParsedToken {
  payload: LicensePayload;
  signature: Buffer;
  rawPayloadBytes?: Buffer;
}

export function parseLicenseToken(rawToken: string): ParsedToken | null {
  const trimmed = rawToken.trim();
  if (!trimmed) return null;

  try {
    if (trimmed.includes(".")) {
      const parts = trimmed.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
      const payloadJson = Buffer.from(parts[0], "base64").toString("utf8");
      const payload = JSON.parse(payloadJson) as LicensePayload;
      const signature = Buffer.from(parts[1], "base64");
      return {
        payload,
        signature,
        rawPayloadBytes: Buffer.from(parts[0]),
      };
    }

    const jsonString = Buffer.from(trimmed, "base64").toString("utf8");
    const envelope = JSON.parse(jsonString) as {
      payload?: LicensePayload;
      signature?: string;
      licensee?: string;
      plan?: string;
      expiresAt?: string;
      issuedAt?: string;
    };

    if (envelope.payload && typeof envelope.signature === "string") {
      return {
        payload: envelope.payload,
        signature: Buffer.from(envelope.signature, "base64"),
      };
    }

    if (
      typeof envelope.licensee === "string" &&
      typeof envelope.plan === "string" &&
      typeof envelope.signature === "string"
    ) {
      const { signature, ...rest } = envelope;
      return {
        payload: rest as unknown as LicensePayload,
        signature: Buffer.from(signature, "base64"),
      };
    }

    return null;
  } catch {
    return null;
  }
}

export function verifyLicenseToken(
  token: string | null | undefined,
  publicKeyPem?: string,
): LicenseVerificationResult {
  if (!token || !token.trim()) {
    return {
      valid: false,
      state: "unlicensed",
      reason: "No license token found.",
    };
  }

  const parsed = parseLicenseToken(token);
  if (!parsed) {
    return {
      valid: false,
      state: "invalid_format",
      reason: "License token format is invalid.",
    };
  }

  const { payload, signature, rawPayloadBytes } = parsed;

  if (
    typeof payload.licensee !== "string" ||
    !payload.licensee.trim() ||
    typeof payload.plan !== "string" ||
    !payload.plan.trim() ||
    typeof payload.expiresAt !== "string" ||
    typeof payload.issuedAt !== "string"
  ) {
    return {
      valid: false,
      state: "invalid_format",
      reason: "License payload is missing required fields (licensee, plan, expiresAt, issuedAt).",
    };
  }

  const pubKey = publicKeyPem ?? getLicensePublicKey();

  let signatureValid = false;
  try {
    const canonicalBytes = Buffer.from(canonicalizePayload(payload), "utf8");
    signatureValid = crypto.verify(null, canonicalBytes, pubKey, signature);
    if (!signatureValid && rawPayloadBytes) {
      signatureValid = crypto.verify(null, rawPayloadBytes, pubKey, signature);
    }
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    return {
      valid: false,
      state: "tampered",
      reason: "Cryptographic signature verification failed.",
      payload,
    };
  }

  const expiresTime = new Date(payload.expiresAt).getTime();
  if (Number.isNaN(expiresTime)) {
    return {
      valid: false,
      state: "invalid_format",
      reason: "License expiration date is invalid.",
      payload,
    };
  }

  if (expiresTime <= Date.now()) {
    return {
      valid: false,
      state: "expired",
      reason: `License expired on ${payload.expiresAt}.`,
      payload,
    };
  }

  return {
    valid: true,
    state: "valid",
    payload,
  };
}

export function tokenToLicenseStatus(
  token: string | null | undefined,
  publicKeyPem?: string,
): LicenseStatus {
  const result = verifyLicenseToken(token, publicKeyPem);
  return {
    active: result.valid,
    state: result.state,
    licensee: result.payload?.licensee,
    plan: result.payload?.plan,
    expiresAt: result.payload?.expiresAt,
    issuedAt: result.payload?.issuedAt,
    reason: result.reason,
    unverified: false,
  };
}
