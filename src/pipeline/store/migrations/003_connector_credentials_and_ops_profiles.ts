import type Database from "better-sqlite3";

export function up(db: Database.Database): void {
  // 1. Connector credentials table (encrypted credentials per client and connector)
  db.exec(`
    create table if not exists connector_credentials (
      client_id text not null,
      connector text not null,
      encrypted_blob text not null,
      created_at text not null,
      updated_at text not null,
      primary key (client_id, connector)
    );

    create index if not exists idx_connector_credentials_client
      on connector_credentials (client_id);
  `);

  // 2. Ops profiles table (operator-confirmed reporting profile per client)
  db.exec(`
    create table if not exists ops_profiles (
      client_id text primary key,
      business_name text not null,
      data text not null,
      confirmed_at text,
      confirmed_by text,
      created_at text not null,
      updated_at text not null
    );
  `);
}
