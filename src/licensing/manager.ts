import { HttpError } from "../server/errors.js";
import { UnlicensedError } from "./errors.js";
import type { LicenseStore } from "./store.js";
import type { LicenseStatus } from "./types.js";
import { tokenToLicenseStatus, verifyLicenseToken } from "./verify.js";

export interface LicenseManagerOptions {
  enforcement?: boolean;
  publicKey?: string;
  staticToken?: string;
}

export class LicenseManager {
  private readonly enforcement: boolean;
  private readonly publicKey?: string;
  private readonly staticToken?: string;

  constructor(
    readonly store: LicenseStore,
    options?: LicenseManagerOptions,
  ) {
    this.enforcement = options?.enforcement ?? false;
    this.publicKey = options?.publicKey;
    this.staticToken = options?.staticToken;
  }

  isEnforcementEnabled(): boolean {
    return this.enforcement;
  }

  async getStatus(): Promise<LicenseStatus> {
    const token = this.staticToken ?? (await this.store.getLicenseToken());
    return tokenToLicenseStatus(token, this.publicKey);
  }

  async activate(token: string): Promise<LicenseStatus> {
    const verification = verifyLicenseToken(token, this.publicKey);
    if (!verification.valid) {
      throw new HttpError(
        400,
        "invalid_license",
        `License activation failed: ${verification.reason ?? "Invalid license token."}`,
        { state: verification.state },
      );
    }
    await this.store.saveLicenseToken(token);
    return this.getStatus();
  }

  async assertActive(actionDescription = "Execution"): Promise<LicenseStatus> {
    const status = await this.getStatus();
    if (!status.active) {
      throw new UnlicensedError(
        `${actionDescription} blocked: ${status.reason ?? "Active license required."} (status: ${status.state})`,
        status,
      );
    }
    return status;
  }
}
