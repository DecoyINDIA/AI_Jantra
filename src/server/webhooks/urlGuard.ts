import { isIP } from "node:net";
import { lookup } from "node:dns/promises";

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);

function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return false;
  const a = parts[0]!;
  const b = parts[1]!;
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata 169.254.169.254
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true;
  return false;
}

function isPrivateIPv6(ip: string): boolean {
  const n = ip.toLowerCase();
  if (n === "::1" || n === "::") return true;
  if (n.startsWith("fc") || n.startsWith("fd")) return true; // unique local fc00::/7
  if (/^fe[89ab]/.test(n)) return true; // link-local fe80::/10
  const mapped = n.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateIPv4(mapped[1]!);
  return false;
}

function isPrivateIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) return isPrivateIPv4(ip);
  if (version === 6) return isPrivateIPv6(ip);
  return true; // unrecognizable → treat as unsafe, do not silently allow
}

/**
 * Reject webhook URLs that could reach internal infrastructure: non-HTTP(S)
 * schemes, loopback/link-local/private hosts, and the cloud metadata endpoint.
 * The server fetches this URL with no caller-visible response, so an unchecked
 * URL is a blind SSRF primitive. Call this both at subscription-create time and
 * immediately before delivery (DNS can change between the two).
 */
export async function assertPublicWebhookUrl(rawUrl: string): Promise<void> {
  const url = new URL(rawUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Webhook URL scheme must be http or https, got "${url.protocol}".`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    throw new Error(`Webhook URL host "${hostname}" is not allowed.`);
  }
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error("Webhook URL resolves to a private or internal address.");
    }
    return;
  }
  const records = await lookup(hostname, { all: true });
  if (!records.length) {
    throw new Error(`Webhook URL host "${hostname}" did not resolve.`);
  }
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error(`Webhook URL host "${hostname}" resolves to a private or internal address.`);
    }
  }
}
