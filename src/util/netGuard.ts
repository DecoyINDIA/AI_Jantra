import * as net from "node:net";
import * as dns from "node:dns/promises";

const blockList = new net.BlockList();

// IPv4 blocked subnets
const IPV4_BLOCKED: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];
for (const [cidr, prefix] of IPV4_BLOCKED) {
  blockList.addSubnet(cidr, prefix, "ipv4");
}

// IPv6 blocked subnets
const IPV6_BLOCKED: Array<[string, number]> = [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
];
for (const [cidr, prefix] of IPV6_BLOCKED) {
  blockList.addSubnet(cidr, prefix, "ipv6");
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain"]);
const BLOCKED_DOMAIN_SUFFIXES = [".localhost", ".local", ".internal"];

export function isBlockedAddress(address: string): boolean {
  const version = net.isIP(address);
  if (version === 0) return true;
  return blockList.check(address, version === 4 ? "ipv4" : "ipv6");
}

export async function assertPublicHost(hostname: string): Promise<string[]> {
  let cleaned = hostname.trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (cleaned.endsWith(".")) {
    cleaned = cleaned.slice(0, -1);
  }
  if (
    BLOCKED_HOSTNAMES.has(cleaned) ||
    BLOCKED_DOMAIN_SUFFIXES.some((suffix) => cleaned.endsWith(suffix))
  ) {
    throw new Error(`Host "${hostname}" is not permitted.`);
  }

  if (net.isIP(cleaned)) {
    if (isBlockedAddress(cleaned)) {
      throw new Error(`Host address is not permitted.`);
    }
    return [cleaned];
  }

  let records: Array<{ address: string; family: number }>;
  try {
    records = await dns.lookup(cleaned, { all: true });
  } catch (err) {
    throw new Error(`Could not resolve host "${hostname}": ${err instanceof Error ? err.message : String(err)}`);
  }

  if (!records.length) {
    throw new Error(`Host "${hostname}" did not resolve to any address.`);
  }

  const addresses: string[] = [];
  for (const record of records) {
    if (isBlockedAddress(record.address)) {
      throw new Error(`Host "${hostname}" resolves to a restricted address.`);
    }
    addresses.push(record.address);
  }

  return addresses;
}
