import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createLicenseToken,
  generateLicenseKeyPair,
  resolvePrivateKey,
  verifyLicenseToken,
  tokenToLicenseStatus,
  canonicalizePayload,
  parseLicenseToken,
  LicenseManager,
  MemoryLicenseStore,
  FileLicenseStore,
  UnlicensedError,
  EMBEDDED_LICENSE_PUBLIC_KEY,
  type LicensePayload,
  type DesktopProviderConfig,
} from "./index.js";

const testSuiteKeyPair = generateLicenseKeyPair();

describe("Offline Ed25519 Licensing", () => {
  it("issues and verifies a valid license token with public key", () => {
    const payload: LicensePayload = {
      licensee: "Acme Healthcare Corp",
      plan: "enterprise",
      expiresAt: new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString(),
      issuedAt: new Date().toISOString(),
    };

    const token = createLicenseToken(payload, testSuiteKeyPair.privateKey);
    assert(typeof token === "string" && token.length > 50, "Expected base64 token");

    // Verify with core verifyLicenseToken
    const verification = verifyLicenseToken(token, testSuiteKeyPair.publicKey);
    assert.equal(verification.valid, true);
    assert.equal(verification.state, "valid");
    assert.equal(verification.payload?.licensee, "Acme Healthcare Corp");
    assert.equal(verification.payload?.plan, "enterprise");

    // Verify status output
    const status = tokenToLicenseStatus(token, testSuiteKeyPair.publicKey);
    assert.equal(status.active, true);
    assert.equal(status.state, "valid");
    assert.equal(status.unverified, false);
    assert.equal(status.licensee, "Acme Healthcare Corp");
    assert.equal(status.plan, "enterprise");
  });

  it("detects license tampering when signature is modified", () => {
    const payload: LicensePayload = {
      licensee: "Tamper Test Corp",
      plan: "pro",
      expiresAt: new Date(Date.now() + 100 * 24 * 60 * 60 * 1000).toISOString(),
      issuedAt: new Date().toISOString(),
    };

    const validToken = createLicenseToken(payload, testSuiteKeyPair.privateKey);
    const parsed = parseLicenseToken(validToken);
    assert(parsed, "Expected valid parsed token");

    // Tamper with the signature bytes
    const tamperedSig = Buffer.from(parsed.signature);
    tamperedSig[0] = (tamperedSig[0]! ^ 0xff);

    const tamperedEnvelope = {
      payload: parsed.payload,
      signature: tamperedSig.toString("base64"),
    };
    const tamperedToken = Buffer.from(JSON.stringify(tamperedEnvelope)).toString("base64");

    const result = verifyLicenseToken(tamperedToken, testSuiteKeyPair.publicKey);
    assert.equal(result.valid, false);
    assert.equal(result.state, "tampered");
    assert.match(result.reason ?? "", /signature verification failed/i);

    const status = tokenToLicenseStatus(tamperedToken, testSuiteKeyPair.publicKey);
    assert.equal(status.active, false);
    assert.equal(status.state, "tampered");
  });

  it("detects license tampering when payload fields are modified without resign", () => {
    const payload: LicensePayload = {
      licensee: "Legit Company",
      plan: "free-trial",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      issuedAt: new Date().toISOString(),
    };

    const validToken = createLicenseToken(payload, testSuiteKeyPair.privateKey);
    const parsed = parseLicenseToken(validToken);
    assert(parsed, "Expected valid parsed token");

    // Tamper with the plan in the payload
    const tamperedPayload: LicensePayload = {
      ...parsed.payload,
      plan: "enterprise-hacked",
    };

    const tamperedEnvelope = {
      payload: tamperedPayload,
      signature: parsed.signature.toString("base64"),
    };
    const tamperedToken = Buffer.from(JSON.stringify(tamperedEnvelope)).toString("base64");

    const result = verifyLicenseToken(tamperedToken, testSuiteKeyPair.publicKey);
    assert.equal(result.valid, false);
    assert.equal(result.state, "tampered");
  });

  it("detects expired license when expiresAt is in the past", () => {
    const pastDate = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const payload: LicensePayload = {
      licensee: "Expired Licensee",
      plan: "pro",
      expiresAt: pastDate,
      issuedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString(),
    };

    const token = createLicenseToken(payload, testSuiteKeyPair.privateKey);
    const result = verifyLicenseToken(token, testSuiteKeyPair.publicKey);
    assert.equal(result.valid, false);
    assert.equal(result.state, "expired");
    assert.match(result.reason ?? "", /expired/i);
    assert.equal(result.payload?.licensee, "Expired Licensee");

    const status = tokenToLicenseStatus(token, testSuiteKeyPair.publicKey);
    assert.equal(status.active, false);
    assert.equal(status.state, "expired");
  });

  it("handles unlicensed state for missing or empty tokens", () => {
    const nullResult = verifyLicenseToken(null, EMBEDDED_LICENSE_PUBLIC_KEY);
    assert.equal(nullResult.valid, false);
    assert.equal(nullResult.state, "unlicensed");

    const emptyResult = verifyLicenseToken("", EMBEDDED_LICENSE_PUBLIC_KEY);
    assert.equal(emptyResult.valid, false);
    assert.equal(emptyResult.state, "unlicensed");

    const malformedResult = verifyLicenseToken("not-a-valid-base64-json!#$%", EMBEDDED_LICENSE_PUBLIC_KEY);
    assert.equal(malformedResult.valid, false);
    assert.equal(malformedResult.state, "invalid_format");
  });

  it("supports dynamic Ed25519 keypair generation and custom public key", () => {
    const customPair = generateLicenseKeyPair();
    const payload: LicensePayload = {
      licensee: "Dynamic Key Corp",
      plan: "custom",
      expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(),
      issuedAt: new Date().toISOString(),
    };

    const token = createLicenseToken(payload, customPair.privateKey);

    // Fails against embedded public key (different key)
    const failedCheck = verifyLicenseToken(token, EMBEDDED_LICENSE_PUBLIC_KEY);
    assert.equal(failedCheck.valid, false);
    assert.equal(failedCheck.state, "tampered");

    // Succeeds against the matching custom public key
    const successCheck = verifyLicenseToken(token, customPair.publicKey);
    assert.equal(successCheck.valid, true);
    assert.equal(successCheck.state, "valid");
  });

  it("re-verifies license token cryptographically on every status read in LicenseManager", async () => {
    const store = new MemoryLicenseStore();
    const manager = new LicenseManager(store, { publicKey: testSuiteKeyPair.publicKey });

    // Initial status: unlicensed
    const initialStatus = await manager.getStatus();
    assert.equal(initialStatus.active, false);
    assert.equal(initialStatus.state, "unlicensed");

    // Activate valid token
    const validPayload: LicensePayload = {
      licensee: "Re-verify Test",
      plan: "pro",
      expiresAt: new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString(),
      issuedAt: new Date().toISOString(),
    };
    const validToken = createLicenseToken(validPayload, testSuiteKeyPair.privateKey);
    const activated = await manager.activate(validToken);
    assert.equal(activated.active, true);
    assert.equal(activated.state, "valid");

    // Next read: still valid
    const secondRead = await manager.getStatus();
    assert.equal(secondRead.active, true);

    // Tamper the stored token directly in the store
    await store.saveLicenseToken("tampered-token-in-store");
    const tamperedRead = await manager.getStatus();
    assert.equal(tamperedRead.active, false);
    assert.equal(tamperedRead.state, "invalid_format");

    // Replace with expired token in store
    const expiredPayload: LicensePayload = {
      licensee: "Expired Test",
      plan: "pro",
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      issuedAt: new Date(Date.now() - 10000).toISOString(),
    };
    const expiredToken = createLicenseToken(expiredPayload, testSuiteKeyPair.privateKey);
    await store.saveLicenseToken(expiredToken);
    const expiredRead = await manager.getStatus();
    assert.equal(expiredRead.active, false);
    assert.equal(expiredRead.state, "expired");

    // assertActive throws UnlicensedError
    await assert.rejects(
      async () => manager.assertActive("Test Operation"),
      (err: unknown) => err instanceof UnlicensedError && err.statusCode === 403,
    );
  });

  it("stores and reads license token from FileLicenseStore", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-lic-test-"));
    const licFile = path.join(tmpDir, "license.json");
    try {
      const fileStore = new FileLicenseStore(licFile);
      assert.equal(await fileStore.getLicenseToken(), null);

      const payload: LicensePayload = {
        licensee: "File Store Test",
        plan: "pro",
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        issuedAt: new Date().toISOString(),
      };
      const token = createLicenseToken(payload, testSuiteKeyPair.privateKey);

      await fileStore.saveLicenseToken(token);
      assert.equal(await fileStore.getLicenseToken(), token);

      // Verify file contents on disk
      const diskContent = JSON.parse(fs.readFileSync(licFile, "utf8")) as { token: string };
      assert.equal(diskContent.token, token);

      await fileStore.deleteLicenseToken();
      assert.equal(await fileStore.getLicenseToken(), null);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("validates multi-provider configuration models and default settings", () => {
    const geminiConfig: DesktopProviderConfig = {
      provider: "gemini",
    };
    assert.equal(geminiConfig.provider, "gemini");

    const customOpenAiConfig: DesktopProviderConfig = {
      provider: "openai-compatible",
      baseUrl: "https://api.openai.com/v1",
      modelFlash: "gpt-4o-mini",
      modelPro: "gpt-4o",
      dataCollection: "deny",
    };
    assert.equal(customOpenAiConfig.provider, "openai-compatible");
    assert.equal(customOpenAiConfig.dataCollection, "deny");
  });

  it("LicenseManager.assertActive fails closed with 403 UnlicensedError across all inactive states without token leakage", async () => {
    const store = new MemoryLicenseStore();
    const manager = new LicenseManager(store, { publicKey: testSuiteKeyPair.publicKey, enforcement: true });

    // 1. Missing token -> unlicensed
    await assert.rejects(
      async () => manager.assertActive("Run execution"),
      (err: any) => {
        assert(err instanceof UnlicensedError);
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, "unlicensed");
        assert.equal(err.status?.state, "unlicensed");
        assert(!JSON.stringify(err).includes("signature"));
        return true;
      },
    );

    // 2. Tampered token -> tampered
    await store.saveLicenseToken("tampered-token-not-valid");
    await assert.rejects(
      async () => manager.assertActive("Run execution"),
      (err: any) => {
        assert(err instanceof UnlicensedError);
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, "unlicensed");
        assert.equal(err.status?.state, "invalid_format");
        return true;
      },
    );

    // 3. Expired token -> expired
    const expiredPayload: LicensePayload = {
      licensee: "Expired Test",
      plan: "pro",
      expiresAt: new Date(Date.now() - 60000).toISOString(),
      issuedAt: new Date(Date.now() - 120000).toISOString(),
    };
    const expiredToken = createLicenseToken(expiredPayload, testSuiteKeyPair.privateKey);
    await store.saveLicenseToken(expiredToken);
    await assert.rejects(
      async () => manager.assertActive("Run execution"),
      (err: any) => {
        assert(err instanceof UnlicensedError);
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, "unlicensed");
        assert.equal(err.status?.state, "expired");
        assert(!JSON.stringify(err).includes(expiredToken));
        return true;
      },
    );

    // 4. Wrong-key token -> tampered
    const roguePair = generateLicenseKeyPair();
    const validFuturePayload: LicensePayload = {
      licensee: "Rogue Signer",
      plan: "enterprise",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
      issuedAt: new Date().toISOString(),
    };
    const wrongKeyToken = createLicenseToken(validFuturePayload, roguePair.privateKey);
    await store.saveLicenseToken(wrongKeyToken);
    await assert.rejects(
      async () => manager.assertActive("Run execution"),
      (err: any) => {
        assert(err instanceof UnlicensedError);
        assert.equal(err.statusCode, 403);
        assert.equal(err.code, "unlicensed");
        assert.equal(err.status?.state, "tampered");
        assert(!JSON.stringify(err).includes(wrongKeyToken));
        return true;
      },
    );

    // 5. Valid token -> succeeds
    const validToken = createLicenseToken(validFuturePayload, testSuiteKeyPair.privateKey);
    await store.saveLicenseToken(validToken);
    const activeStatus = await manager.assertActive("Run execution");
    assert.equal(activeStatus.active, true);
    assert.equal(activeStatus.state, "valid");
  });

  it("resolvePrivateKey is pure and ignores environment variables", () => {
    const origEnv = process.env.JANTRA_LICENSE_PRIVATE_KEY;
    try {
      process.env.JANTRA_LICENSE_PRIVATE_KEY = testSuiteKeyPair.privateKey;
      // Without argument, it MUST throw even if JANTRA_LICENSE_PRIVATE_KEY is set in environment
      assert.throws(
        () => resolvePrivateKey(undefined),
        /requires an Ed25519 private key/i,
      );

      // With explicit PEM content, it returns the trimmed PEM
      assert.equal(resolvePrivateKey(testSuiteKeyPair.privateKey), testSuiteKeyPair.privateKey.trim());
    } finally {
      if (origEnv) process.env.JANTRA_LICENSE_PRIVATE_KEY = origEnv;
      else delete process.env.JANTRA_LICENSE_PRIVATE_KEY;
    }
  });

  it("CLI script issue-license.ts enforces secure key generation and issuance isolation", async () => {
    const { execFileSync } = await import("node:child_process");
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "jantra-cli-lic-"));
    const pubFile = path.join(tmpDir, "license.pub");
    const privFile = path.join(tmpDir, "license.priv");
    const scriptPath = path.resolve("scripts/issue-license.ts");

    try {
      // 1. Issuing without key or env exits nonzero
      assert.throws(
        () => {
          execFileSync(
            process.execPath,
            ["--import", "tsx", scriptPath, "--licensee", "NoKey Corp"],
            { env: { ...process.env, JANTRA_LICENSE_PRIVATE_KEY: "" }, stdio: "pipe" },
          );
        },
        (err: any) => err.status === 1,
      );

      // 2. --generate-keys without output files exits nonzero
      assert.throws(
        () => {
          execFileSync(
            process.execPath,
            ["--import", "tsx", scriptPath, "--generate-keys"],
            { stdio: "pipe" },
          );
        },
        (err: any) => err.status === 1,
      );

      // 3. --generate-keys writes files and never outputs private key to stdout
      const genOutput = execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--generate-keys", "--public-out", pubFile, "--private-out", privFile],
        { encoding: "utf8" },
      );

      assert(fs.existsSync(pubFile), "public key file must be created");
      assert(fs.existsSync(privFile), "private key file must be created");
      assert(!genOutput.includes("BEGIN PRIVATE KEY"), "stdout must not contain private key");
      assert(!genOutput.includes("BEGIN ED25519 PRIVATE KEY"), "stdout must not contain private key");
      assert(genOutput.includes("Public Key SHA-256:"), "stdout must contain public key fingerprint");

      // 4. Overwrite without --force fails
      assert.throws(
        () => {
          execFileSync(
            process.execPath,
            ["--import", "tsx", scriptPath, "--generate-keys", "--public-out", pubFile, "--private-out", privFile],
            { stdio: "pipe" },
          );
        },
        (err: any) => err.status === 1,
      );

      // 5. Overwrite with --force succeeds
      const forceOutput = execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--generate-keys", "--public-out", pubFile, "--private-out", privFile, "--force"],
        { encoding: "utf8" },
      );
      assert(!forceOutput.includes("BEGIN PRIVATE KEY"), "stdout must not contain private key with --force");

      // 6. Issue license using the newly generated private key file
      const issueOutput = execFileSync(
        process.execPath,
        ["--import", "tsx", scriptPath, "--licensee", "Generated Key Customer", "--key", privFile],
        { encoding: "utf8" },
      );
      assert(issueOutput.includes("Jantra License Token Issued"), "license must be issued");
      const tokenMatch = issueOutput.match(/License Token \(base64\):\s*\n([A-Za-z0-9+/=]+)/);
      assert(tokenMatch && tokenMatch[1], "token must be in stdout");
      const token = tokenMatch[1].trim();

      // Verify with matching public key
      const pubKeyPem = fs.readFileSync(pubFile, "utf8");
      const verifyResult = verifyLicenseToken(token, pubKeyPem);
      assert.equal(verifyResult.valid, true);
      assert.equal(verifyResult.payload?.licensee, "Generated Key Customer");

      // Verify against embedded key -> tampered
      const embeddedVerify = verifyLicenseToken(token, EMBEDDED_LICENSE_PUBLIC_KEY);
      assert.equal(embeddedVerify.valid, false);
      assert.equal(embeddedVerify.state, "tampered");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
