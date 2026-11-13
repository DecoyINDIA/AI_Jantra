import type Database from "better-sqlite3";
import { up as up001 } from "./001_baseline.js";
import { up as up002 } from "./002_add_mirrored_columns_and_tables.js";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
}

export const ALL_MIGRATIONS: Migration[] = [
  { version: 1, name: "001_baseline", up: up001 },
  { version: 2, name: "002_add_mirrored_columns_and_tables", up: up002 },
];

export function runMigrations(db: Database.Database): number {
  db.exec(`
    create table if not exists schema_migrations (
      version integer primary key,
      name text not null,
      applied_at text not null
    );
  `);

  const appliedRows = db.prepare("select version from schema_migrations").all() as Array<{ version: number }>;
  const appliedSet = new Set(appliedRows.map((r) => r.version));

  let count = 0;
  for (const migration of ALL_MIGRATIONS) {
    if (!appliedSet.has(migration.version)) {
      const runTx = db.transaction(() => {
        migration.up(db);
        db.prepare("insert into schema_migrations (version, name, applied_at) values (?, ?, ?)").run(
          migration.version,
          migration.name,
          new Date().toISOString(),
        );
      });
      runTx();
      count++;
    }
  }

  return count;
}
