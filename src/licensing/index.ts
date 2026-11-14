import { config } from "../config.js";
import { LicenseManager } from "./manager.js";
import { FileLicenseStore, type LicenseStore } from "./store.js";

export * from "./types.js";
export * from "./keys.js";
export * from "./verify.js";
export * from "./issue.js";
export * from "./errors.js";
export * from "./store.js";
export * from "./manager.js";

export function createDefaultLicenseStore(): LicenseStore {
  const targetPath = config.licensePath || `${config.dataDir}/license.json`;
  return new FileLicenseStore(targetPath);
}

export const defaultLicenseStore = createDefaultLicenseStore();

export const defaultLicenseManager = new LicenseManager(defaultLicenseStore, {
  enforcement: config.licenseEnforcement,
  staticToken: config.licenseToken,
});
