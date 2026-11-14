#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import process from "node:process";
import { EMBEDDED_LICENSE_PUBLIC_KEY } from "../src/licensing/keys.js";
import { createLicenseToken, generateLicenseKeyPair } from "../src/licensing/issue.js";
import { verifyLicenseToken } from "../src/licensing/verify.js";
import type { LicensePayload } from "../src/licensing/types.js";

function printUsage(): void {
  console.log(`
Jantra License Issuance Tool

Usage:
  npx tsx scripts/issue-license.ts --licensee "<name>" [options]
  npx tsx scripts/issue-license.ts --verify "<token>"
  npx tsx scripts/issue-license.ts --generate-keys

Options:
  --licensee <name>     Name of the licensee / customer (required for issue)
  --plan <plan>         License plan tier (default: "pro")
  --days <number>       Validity duration in days from now (default: 365)
  --expires <ISO-date>  Explicit expiration date (e.g. 2027-12-31T23:59:59Z)
  --key <file>          Path to Ed25519 private key PEM file
  --verify <token>      Verify a base64 license token and print its payload
  --generate-keys       Generate a new Ed25519 keypair and print SPKI/PKCS#8 PEMs
  --help                Show this help message
`);
}

function parseArgs(): Record<string, string | boolean> {
  const args = process.argv.slice(2);
  const result: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--generate-keys") {
      result.generateKeys = true;
    } else if (arg === "--verify") {
      result.verify = args[++i] ?? "";
    } else if (arg.startsWith("--verify=")) {
      result.verify = arg.slice("--verify=".length);
    } else if (arg === "--licensee") {
      result.licensee = args[++i] ?? "";
    } else if (arg.startsWith("--licensee=")) {
      result.licensee = arg.slice("--licensee=".length);
    } else if (arg === "--plan") {
      result.plan = args[++i] ?? "pro";
    } else if (arg.startsWith("--plan=")) {
      result.plan = arg.slice("--plan=".length);
    } else if (arg === "--days") {
      result.days = args[++i] ?? "365";
    } else if (arg.startsWith("--days=")) {
      result.days = arg.slice("--days=".length);
    } else if (arg === "--expires") {
      result.expires = args[++i] ?? "";
    } else if (arg.startsWith("--expires=")) {
      result.expires = arg.slice("--expires=".length);
    } else if (arg === "--key") {
      result.key = args[++i] ?? "";
    } else if (arg.startsWith("--key=")) {
      result.key = arg.slice("--key=".length);
    }
  }

  return result;
}

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

export function main(): void {
  const opts = parseArgs();

  if (opts.help) {
    printUsage();
    return;
  }

  if (opts.generateKeys) {
    const pair = generateLicenseKeyPair();
    console.log("=== Generated New Ed25519 Keypair ===\n");
    console.log("Public Key (embed in application):");
    console.log(pair.publicKey);
    console.log("Private Key (keep secret for signing):");
    console.log(pair.privateKey);
    return;
  }

  if (typeof opts.verify === "string") {
    const token = opts.verify.trim();
    if (!token) {
      console.error("Error: --verify requires a token argument.");
      process.exit(1);
    }
    const result = verifyLicenseToken(token);
    console.log("\n=== License Verification Result ===");
    console.log(`Valid:   ${result.valid ? "YES" : "NO"}`);
    console.log(`State:   ${result.state}`);
    if (result.reason) console.log(`Reason:  ${result.reason}`);
    if (result.payload) {
      console.log(`Licensee: ${result.payload.licensee}`);
      console.log(`Plan:     ${result.payload.plan}`);
      console.log(`Issued:   ${result.payload.issuedAt}`);
      console.log(`Expires:  ${result.payload.expiresAt}`);
    }
    process.exit(result.valid ? 0 : 1);
  }

  const licensee = typeof opts.licensee === "string" ? opts.licensee.trim() : "";
  if (!licensee) {
    console.error("Error: --licensee <name> is required to issue a license.\n");
    printUsage();
    process.exit(1);
  }

  const plan = typeof opts.plan === "string" && opts.plan.trim() ? opts.plan.trim() : "pro";
  const now = new Date();
  const issuedAt = now.toISOString();

  let expiresAt: string;
  if (typeof opts.expires === "string" && opts.expires.trim()) {
    expiresAt = new Date(opts.expires.trim()).toISOString();
  } else {
    const days = typeof opts.days === "string" ? parseInt(opts.days, 10) : 365;
    const expiresDate = new Date(now.getTime() + (Number.isNaN(days) ? 365 : days) * 24 * 60 * 60 * 1000);
    expiresAt = expiresDate.toISOString();
  }

  const payload: LicensePayload = {
    licensee,
    plan,
    expiresAt,
    issuedAt,
  };

  let privateKey: string;
  try {
    privateKey = resolvePrivateKey(opts.key);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    printUsage();
    process.exit(1);
  }

  const token = createLicenseToken(payload, privateKey);

  // Verification sanity check
  try {
    const derivedPublicKey = crypto.createPublicKey(privateKey).export({ type: "spki", format: "pem" }) as string;
    const selfCheck = verifyLicenseToken(token, derivedPublicKey);
    if (!selfCheck.valid) {
      console.error("Self-verification failed:", selfCheck.reason);
      process.exit(1);
    }
  } catch (err) {
    console.error("Failed to verify license with signing key:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const embeddedCheck = verifyLicenseToken(token, EMBEDDED_LICENSE_PUBLIC_KEY);
  if (!embeddedCheck.valid) {
    console.warn("Notice: Token was signed with an external key that does not match EMBEDDED_LICENSE_PUBLIC_KEY.");
  }

  console.log("\n=== Jantra License Token Issued ===");
  console.log(`Licensee:  ${payload.licensee}`);
  console.log(`Plan:      ${payload.plan}`);
  console.log(`Issued At: ${payload.issuedAt}`);
  console.log(`Expires:   ${payload.expiresAt}`);
  console.log("\nLicense Token (base64):");
  console.log(token);
  console.log("");
}

if (process.argv[1]?.endsWith("issue-license.ts") || process.argv[1]?.endsWith("issue-license.js")) {
  main();
}
