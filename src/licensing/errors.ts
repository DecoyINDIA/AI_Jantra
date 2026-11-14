import { HttpError } from "../server/errors.js";
import type { LicenseStatus } from "./types.js";

export class UnlicensedError extends HttpError {
  constructor(message: string, readonly status?: LicenseStatus) {
    super(403, "unlicensed", message, status ? { licenseStatus: status } : undefined);
    this.name = "UnlicensedError";
  }
}

export function unlicensed(message: string, status?: LicenseStatus): UnlicensedError {
  return new UnlicensedError(message, status);
}
