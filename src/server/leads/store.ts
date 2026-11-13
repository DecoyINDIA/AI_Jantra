import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { config } from "../../config.js";
import { assertSafePathSegment } from "../../pipeline/store.js";

// Lead capture is intentionally a small, self-contained JSON store rather than
// part of the project ProjectStore: leads are low-volume marketing records with
// a different lifecycle (no stages, no cost, no tenancy beyond the owning user)
// and we do not want to couple them to the planning-pipeline schema.

let atomicSeq = 0;

function atomicWriteFileSync(path: string, data: string): void {
  const tmp = `${path}.${process.pid}.${atomicSeq++}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

function clientLeadDir(clientId: string): string {
  return join(config.leadDir, assertSafePathSegment(clientId, "clientId"));
}

function leadFile(clientId: string, leadId: string): string {
  return join(clientLeadDir(clientId), `${assertSafePathSegment(leadId, "leadId")}.json`);
}

export interface LeadRecord {
  id: string;
  clientId: string;
  /** Verified Logto subject when the visitor was logged in, otherwise null. */
  userSub: string | null;
  name: string;
  email: string;
  phone?: string;
  idea: string;
  source: string;
  runId?: string;
  createdAt: string;
}

export interface LeadStore {
  createLead(record: LeadRecord): LeadRecord;
  listLeads(clientId: string): LeadRecord[];
  listLeadsByUser(clientId: string, userSub: string): LeadRecord[];
}

export class JsonLeadStore implements LeadStore {
  createLead(record: LeadRecord): LeadRecord {
    mkdirSync(clientLeadDir(record.clientId), { recursive: true });
    atomicWriteFileSync(
      leadFile(record.clientId, record.id),
      JSON.stringify(record, null, 2),
    );
    return record;
  }

  listLeads(clientId: string): LeadRecord[] {
    const dir = clientLeadDir(clientId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as LeadRecord)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listLeadsByUser(clientId: string, userSub: string): LeadRecord[] {
    const dir = clientLeadDir(clientId);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as LeadRecord)
      .filter((lead) => lead.userSub === userSub)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}

export const defaultLeadStore: LeadStore = new JsonLeadStore();
