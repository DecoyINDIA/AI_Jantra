import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import crypto from "node:crypto";
import { desktopLicensePath } from "./paths.js";

/**
 * Production Ed25519 public key embedded in the desktop build.
 */
export const EMBEDDED_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA72cUexcscRKCgpnDMTCsIGNJkrfpUezoMtqwAzutqgU=
-----END PUBLIC KEY-----`;

export interface LicensePayload {
  licensee: string;
  plan: string;
  expiresAt: string;
  issuedAt: string;
}

export type LicenseState =
  | "valid"
  | "expired"
  | "tampered"
  | "invalid_format"
  | "unlicensed";

export interface LicenseStatus {
  active: boolean;
  state: LicenseState;
  licensee?: string;
  plan?: string;
  expiresAt?: string;
  issuedAt?: string;
  reason?: string;
  unverified: boolean;
  activatedAt?: string;
}

export interface LicenseVerificationResult {
  valid: boolean;
  state: LicenseState;
  reason?: string;
  payload?: LicensePayload;
}

function canonicalizePayload(payload: LicensePayload): string {
  const sorted: Record<string, string> = {
    expiresAt: String(payload.expiresAt ?? ""),
    issuedAt: String(payload.issuedAt ?? ""),
    licensee: String(payload.licensee ?? ""),
    plan: String(payload.plan ?? ""),
  };
  return JSON.stringify(sorted);
}

export function parseLicenseToken(rawToken: string): {
  payload: LicensePayload;
  signature: Buffer;
  rawPayloadBytes?: Buffer;
} | null {
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

export function verifyDesktopLicenseToken(
  token: string | null | undefined,
  publicKeyPem = EMBEDDED_LICENSE_PUBLIC_KEY,
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
      reason: "License payload missing required fields (licensee, plan, expiresAt, issuedAt).",
    };
  }

  let signatureValid = false;
  try {
    const canonicalBytes = Buffer.from(canonicalizePayload(payload), "utf8");
    signatureValid = crypto.verify(null, canonicalBytes, publicKeyPem, signature);
    if (!signatureValid && rawPayloadBytes) {
      signatureValid = crypto.verify(null, rawPayloadBytes, publicKeyPem, signature);
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

export async function activateLicense(
  token: string,
  publicKeyPem = EMBEDDED_LICENSE_PUBLIC_KEY,
): Promise<LicenseStatus> {
  const verification = verifyDesktopLicenseToken(token, publicKeyPem);
  if (!verification.valid) {
    throw new Error(
      `License activation failed: ${verification.reason ?? "Invalid license token."}`,
    );
  }

  const path = desktopLicensePath();
  await mkdir(dirname(path), { recursive: true });
  const activatedAt = new Date().toISOString();
  await writeFile(
    path,
    JSON.stringify(
      {
        token,
        activatedAt,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    active: true,
    state: "valid",
    licensee: verification.payload?.licensee,
    plan: verification.payload?.plan,
    expiresAt: verification.payload?.expiresAt,
    issuedAt: verification.payload?.issuedAt,
    activatedAt,
    unverified: false,
  };
}

export async function licenseStatus(
  publicKeyPem = EMBEDDED_LICENSE_PUBLIC_KEY,
): Promise<LicenseStatus> {
  try {
    const path = desktopLicensePath();
    const raw = JSON.parse(await readFile(path, "utf8")) as {
      token?: string;
      activatedAt?: string;
    };
    const token = typeof raw.token === "string" ? raw.token : undefined;
    const verification = verifyDesktopLicenseToken(token, publicKeyPem);

    return {
      active: verification.valid,
      state: verification.state,
      licensee: verification.payload?.licensee,
      plan: verification.payload?.plan,
      expiresAt: verification.payload?.expiresAt,
      issuedAt: verification.payload?.issuedAt,
      reason: verification.reason,
      activatedAt: raw.activatedAt,
      unverified: false,
    };
  } catch {
    return {
      active: false,
      state: "unlicensed",
      unverified: false,
      reason: "No license token found.",
    };
  }
}
