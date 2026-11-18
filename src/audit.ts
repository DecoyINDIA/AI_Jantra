import { createHash, createHmac } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

import { config } from "./config.js";

/**
 * The audit trail is the product's core promise: "you can see everything it did,
 * and why." Every model turn, tool call, policy decision, approval, and handoff
 * is appended as one JSON line, with a timestamp and the run id. Append-only,
 * synchronous on purpose. We never want to lose an entry to a crash.
 */
export type AuditType =
  | "run_created"
  | "run_start"
  | "run_end"
  | "interaction"
  | "agent_thinking"
  | "agent_message"
  | "tool_call"
  | "policy_decision"
  | "approval"
  | "tool_result"
  | "handoff"
  | "model_call"
  | "model_usage"
  | "eval_score"
  | "citation_verified"
  | "citation_rejected"
  | "guardrail_block"
  | "stage_gate"
  | "cost_rollup"
  | "cost_ceiling_exceeded"
  | "source_registered"
  | "source_cap_applied"
  | "key_created"
  | "key_revoked"
  | "resume"
  | "gateway_completion"
  | "gateway_cost_exceeded"
  | "job_started"
  | "job_finished"
  | "job_failed"
  | "lead_deleted"
  | "report_delivered"
  | "error";

export interface AuditEntry {
  ts: string;
  runId: string;
  type: AuditType;
  clientId?: string;
  [key: string]: unknown;
}

export type AuditPublisher = (entry: AuditEntry) => void;

let auditPublisher: AuditPublisher | null = null;

export function setAuditPublisher(publisher: AuditPublisher | null): void {
  auditPublisher = publisher;
}

const LARGE_FIELD_KEYS = new Set(["input", "content", "data", "text"]);
const SECRET_KEY_PATTERN = /(api[_-]?key|token|secret|password|authorization|bearer)/i;

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function truncateString(value: string, maxBytes: number): string {
  const bytes = byteLength(value);
  if (bytes <= maxBytes) return value;
  let marker = `...[truncated ${bytes} bytes]`;
  let prefixBytes = Math.max(0, maxBytes - byteLength(marker));
  let prefix = Buffer.from(value, "utf8").subarray(0, prefixBytes).toString("utf8");
  marker = `...[truncated ${bytes - byteLength(prefix)} bytes]`;
  prefixBytes = Math.max(0, maxBytes - byteLength(marker));
  prefix = Buffer.from(value, "utf8").subarray(0, prefixBytes).toString("utf8");
  return `${prefix}${marker}`;
}

function truncateLargeField(value: unknown): unknown {
  const maxBytes = config.auditMaxFieldBytes;
  if (maxBytes <= 0) return value;
  if (typeof value === "string") return truncateString(value, maxBytes);
  const serialized = JSON.stringify(value);
  if (serialized === undefined || byteLength(serialized) <= maxBytes) return value;
  return truncateString(serialized, maxBytes);
}

function sanitizeAuditData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).map(([key, value]) => [
      key,
      LARGE_FIELD_KEYS.has(key) ? truncateLargeField(value) : value,
    ]),
  );
}

export function redactToolInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) return input;
  return Object.fromEntries(
    Object.entries(input).map(([key, value]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? "[redacted]" : value,
    ]),
  );
}

/**
 * Tamper evidence. Each line carries `seq`, `prevHash` and `hash`, where
 * hash = H(prevHash + "\n" + JSON of the entry without `hash`). Editing,
 * reordering or deleting a line breaks every later link. With
 * JANTRA_AUDIT_HMAC_KEY set, H is HMAC-SHA256 under a key that does not live
 * on the audit disk, so someone who can write the files still cannot forge a
 * consistent chain. Without it (SHA-256) the chain catches accidental damage
 * and naive edits but a writer could recompute it; deleting lines from the end
 * is only detectable against a head hash recorded elsewhere.
 */
export const AUDIT_CHAIN_GENESIS = "0".repeat(64);

export type AuditHashAlg = "sha256" | "hmac-sha256";

function chainAlg(): AuditHashAlg {
  return config.auditHmacKey ? "hmac-sha256" : "sha256";
}

export function auditChainHash(prevHash: string, body: string, key = config.auditHmacKey): string {
  const payload = `${prevHash}\n${body}`;
  return key
    ? createHmac("sha256", key).update(payload, "utf8").digest("hex")
    : createHash("sha256").update(payload, "utf8").digest("hex");
}

interface ChainHead {
  seq: number;
  hash: string;
  size: number;
}

// Shared by every logger in this process: several loggers append to the same
// file (the "system" and admin logs, per-request run loggers), and a
// per-instance head would fork the chain.
const chainHeads = new Map<string, ChainHead>();

function readLastLine(file: string, size: number): string | null {
  if (size === 0) return null;
  const fd = openSync(file, "r");
  try {
    let chunk = 4096;
    while (true) {
      const length = Math.min(chunk, size);
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      const text = buffer.toString("utf8").replace(/\n+$/, "");
      const newline = text.lastIndexOf("\n");
      if (newline >= 0) return text.slice(newline + 1);
      if (length === size) return text || null;
      chunk *= 4;
    }
  } finally {
    closeSync(fd);
  }
}

function currentHead(file: string): ChainHead {
  const size = existsSync(file) ? statSync(file).size : 0;
  const cached = chainHeads.get(file);
  // Size matches our last write, so nobody else appended since.
  if (cached && cached.size === size) return cached;
  let head: ChainHead = { seq: 0, hash: AUDIT_CHAIN_GENESIS, size };
  const last = readLastLine(file, size);
  if (last) {
    try {
      const parsed = JSON.parse(last) as { seq?: unknown; hash?: unknown };
      if (typeof parsed.seq === "number" && typeof parsed.hash === "string") {
        head = { seq: parsed.seq, hash: parsed.hash, size };
      }
    } catch {
      // A torn or legacy last line: start a fresh link from genesis; the
      // verifier reports the break rather than us guessing.
    }
  }
  chainHeads.set(file, head);
  return head;
}

const LOCK_WAIT_MS = 2_000;
const LOCK_STALE_MS = 10_000;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

/**
 * Cross-process mutual exclusion for one audit file. Appends are synchronous
 * and tiny, so a lock file created with O_EXCL plus a short synchronous wait
 * is enough. A lock older than LOCK_STALE_MS belongs to a crashed process and
 * is broken. If the lock cannot be taken in time we throw: an audit line that
 * might fork the chain is worse than a failed (and retried) step.
 */
function withAuditFileLock<T>(file: string, fn: () => T): T {
  const lockPath = `${file}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd: number | null = null;
  while (fd === null) {
    try {
      fd = openSync(lockPath, "wx");
      writeSync(fd, `${process.pid}`);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        // Lock vanished between checks; retry immediately.
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(`Timed out waiting for audit lock ${lockPath}.`);
      }
      Atomics.wait(sleepCell, 0, 0, 2);
    }
  }
  try {
    return fn();
  } finally {
    closeSync(fd);
    try {
      unlinkSync(lockPath);
    } catch {
      // Already broken as stale by another process; nothing to release.
    }
  }
}

export interface AuditChainReport {
  ok: boolean;
  alg: AuditHashAlg;
  entries: number;
  /** Entries written before chaining existed; allowed only as a prefix. */
  legacyEntries: number;
  headSeq: number;
  headHash: string;
  /** 1-based line number of the first broken link, if any. */
  brokenAtLine?: number;
  reason?: string;
}

export interface AuditAnchor {
  seq: number;
  hash: string;
}

/**
 * Current chain head for a run, or null if it has no chained entries. Sent
 * out with webhooks so receivers hold anchors the audit disk cannot rewrite:
 * a chain that was later truncated or rebuilt will not contain them.
 */
export function getAuditHead(runId: string, dir = config.auditDir): AuditAnchor | null {
  const head = currentHead(join(dir, `${runId}.jsonl`));
  return head.seq > 0 ? { seq: head.seq, hash: head.hash } : null;
}

export function verifyAuditChainText(
  text: string,
  key = config.auditHmacKey,
  anchor?: AuditAnchor,
): AuditChainReport {
  const alg: AuditHashAlg = key ? "hmac-sha256" : "sha256";
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  let legacy = 0;
  let prevHash = AUDIT_CHAIN_GENESIS;
  let prevSeq = 0;
  let chained = false;
  const fail = (line: number, reason: string): AuditChainReport => ({
    ok: false,
    alg,
    entries: lines.length,
    legacyEntries: legacy,
    headSeq: prevSeq,
    headHash: prevHash,
    brokenAtLine: line,
    reason,
  });
  for (let i = 0; i < lines.length; i++) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      return fail(i + 1, "unparseable line");
    }
    const { hash, ...rest } = entry;
    if (typeof hash !== "string") {
      if (chained) return fail(i + 1, "unchained entry after chain start");
      legacy++;
      continue;
    }
    chained = true;
    if (rest.prevHash !== prevHash) return fail(i + 1, "prevHash does not match previous entry");
    if (rest.seq !== prevSeq + 1) return fail(i + 1, "sequence gap");
    if (auditChainHash(prevHash, JSON.stringify(rest), key) !== hash) {
      return fail(i + 1, "hash mismatch (entry modified or wrong key)");
    }
    prevHash = hash;
    prevSeq = rest.seq as number;
    if (anchor && prevSeq === anchor.seq && hash !== anchor.hash) {
      return fail(i + 1, "anchor hash mismatch (chain rewritten after the anchor was issued)");
    }
  }
  // Tail truncation leaves a valid but shorter chain; only an anchor recorded
  // elsewhere reveals it.
  if (anchor && anchor.seq > prevSeq) {
    return fail(lines.length, `chain ends at seq ${prevSeq} but anchor seq ${anchor.seq} was issued (truncated)`);
  }
  return {
    ok: true,
    alg,
    entries: lines.length,
    legacyEntries: legacy,
    headSeq: prevSeq,
    headHash: prevHash,
  };
}

export function verifyAuditFile(runId: string, dir = config.auditDir, anchor?: AuditAnchor): AuditChainReport {
  const file = join(dir, `${runId}.jsonl`);
  return verifyAuditChainText(existsSync(file) ? readFileSync(file, "utf8") : "", config.auditHmacKey, anchor);
}

export class AuditLogger {
  private readonly file: string;
  readonly entries: AuditEntry[] = [];

  constructor(
    readonly runId: string,
    dir: string,
  ) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `${runId}.jsonl`);
  }

  record(type: AuditType, data: Record<string, unknown> = {}): void {
    const safeData = sanitizeAuditData(data);
    // Chain fields are written last so caller data cannot overwrite them.
    const { seq: _seq, prevHash: _prev, hash: _hash, hashAlg: _alg, ...callerData } = safeData;
    // Read-head, sign and append as one step across processes; otherwise two
    // writers can link to the same head and fork the chain.
    const entry = withAuditFileLock(this.file, () => {
      const head = currentHead(this.file);
      const unsigned: AuditEntry = {
        ts: new Date().toISOString(),
        runId: this.runId,
        type,
        ...callerData,
        seq: head.seq + 1,
        prevHash: head.hash,
        hashAlg: chainAlg(),
      };
      const hash = auditChainHash(head.hash, JSON.stringify(unsigned));
      const signed: AuditEntry = { ...unsigned, hash };
      const line = JSON.stringify(signed) + "\n";
      appendFileSync(this.file, line, "utf8");
      chainHeads.set(this.file, {
        seq: head.seq + 1,
        hash,
        size: head.size + Buffer.byteLength(line, "utf8"),
      });
      return signed;
    });
    this.entries.push(entry);
    auditPublisher?.(entry);
  }

  get path(): string {
    return this.file;
  }
}
