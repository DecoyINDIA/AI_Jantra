export interface LicensePayload {
  licensee: string;
  plan: string;
  expiresAt: string;
  issuedAt: string;
}

export interface LicenseEnvelope {
  payload: LicensePayload;
  signature: string;
}

export type LicenseState =
  | "valid"
  | "expired"
  | "tampered"
  | "invalid_format"
  | "unlicensed";

export interface LicenseVerificationResult {
  valid: boolean;
  state: LicenseState;
  reason?: string;
  payload?: LicensePayload;
}

export interface LicenseStatus {
  active: boolean;
  state: LicenseState;
  licensee?: string;
  plan?: string;
  expiresAt?: string;
  issuedAt?: string;
  reason?: string;
  unverified: boolean;
}

export type DesktopProviderKind = "gemini" | "openai-compatible";

export interface DesktopProviderConfig {
  provider: DesktopProviderKind;
  baseUrl?: string;
  modelFlash?: string;
  modelPro?: string;
  dataCollection?: "deny" | "allow";
}

export interface DesktopCredentials {
  geminiApiKey?: string;
  openAiApiKey?: string;
}
