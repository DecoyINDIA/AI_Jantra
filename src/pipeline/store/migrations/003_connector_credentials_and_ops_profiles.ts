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

  // 3. Sanitize legacy plaintext delivery settings if any exist
  try {
    const rows = db.prepare("select client_id, data from ops_profiles").all() as Array<{
      client_id: string;
      data: string;
    }>;
    const updateStmt = db.prepare("update ops_profiles set data = ? where client_id = ?");
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row.data);
        if (parsed.delivery && (parsed.delivery.webhookUrl || parsed.delivery.webhookSecret)) {
          parsed.delivery = { channel: "none" };
          updateStmt.run(JSON.stringify(parsed), row.client_id);
        }
      } catch {}
    }
  } catch {}
}
