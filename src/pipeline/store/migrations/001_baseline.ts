import type Database from "better-sqlite3";

export function up(db: Database.Database): void {
  db.exec(`
    create table if not exists projects (
      client_id text not null,
      project_id text not null,
      updated_at text not null,
      data text not null,
      primary key (client_id, project_id)
    );

    create table if not exists api_keys (
      id text primary key,
      key_hash text not null unique,
      prefix text not null,
      client_id text not null,
      subject text not null,
      label text not null,
      created_at text not null,
      last_used_at text,
      revoked_at text
    );

    create index if not exists idx_api_keys_client_id_created_at
      on api_keys (client_id, created_at desc);

    create index if not exists idx_api_keys_revoked_at
      on api_keys (revoked_at);

    create table if not exists client_daily_ideation_spend (
      client_id text not null,
      day_utc text not null,
      usd real not null,
      primary key (client_id, day_utc)
    );

    create table if not exists client_daily_gateway_spend (
      client_id text not null,
      day_utc text not null,
      usd real not null,
      primary key (client_id, day_utc)
    );
  `);
}
