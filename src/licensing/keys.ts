import { config } from "../config.js";

/**
 * Production Ed25519 public key embedded in Jantra builds.
 * Key type: SPKI PEM (Ed25519).
 */
export const EMBEDDED_LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA72cUexcscRKCgpnDMTCsIGNJkrfpUezoMtqwAzutqgU=
-----END PUBLIC KEY-----`;

export function getLicensePublicKey(): string {
  return config.licensePublicKey?.trim() || EMBEDDED_LICENSE_PUBLIC_KEY;
}
