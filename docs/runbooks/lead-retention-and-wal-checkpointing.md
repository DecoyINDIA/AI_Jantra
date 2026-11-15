# Operational Runbook: SQLite Lead Retention, WAL Checkpointing, and Backup Rotation

This document establishes operational procedures for lead retention, deletion, WAL checkpointing, and backup lifecycle management in Jantra runtime (fulfilling R-001 / T-023).

---

## 1. Physical Storage and SQL Deletion Boundaries

When a lead row or project record is deleted in SQLite (`DELETE FROM leads ...` or `DELETE FROM projects ...`):
1. **Logical Erasure:** The database engine marks the corresponding B-tree cells as free/unused and removes index pointers. Subsequent SQL queries cannot retrieve the deleted data.
2. **Physical Storage:** SQL deletion does not immediately overwrite or zero out pages on physical disk media, nor does it immediately erase pages preserved in the SQLite Write-Ahead Log (`jantra.sqlite-wal`) or historical database backup files.
3. **Honesty Principle:** Never claim physical media erasure from a SQL `DELETE` alone. Compliance with data-protection requirements (GDPR Article 17, CCPA, etc.) requires operational WAL checkpointing, database vacuuming, and historical backup expiration.

---

## 2. SQLite WAL Checkpointing Procedure

SQLite operates in Write-Ahead Log (WAL) mode (`PRAGMA journal_mode=WAL`). Changes are written sequentially to `jantra.sqlite-wal` before being checkpointed back to the main database file `jantra.sqlite`.

### Automatic Checkpointing
SQLite automatically checkpoints when the WAL file reaches 1,000 pages (approx. 4MB). However, to guarantee that deleted pages are flushed and the WAL file is truncated after deletion sweeps:

### Manual / Scheduled Checkpoint Runbook
Run the following commands via the SQLite CLI or operational script:

```bash
# 1. Truncate the WAL file, transferring all pages back to the database and resetting WAL to 0 bytes
sqlite3 /data/jantra/projects/jantra.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"

# 2. (Optional/Periodic) Reclaim free pages and defragment database storage
sqlite3 /data/jantra/projects/jantra.sqlite "VACUUM;"
```

### Automation via Cron / Operational Daemon
In containerized environments (Render, Railway, Kubernetes), configure a periodic maintenance task (e.g. daily, following the lead retention sweep):

```cron
# Daily at 03:00 UTC: Checkpoint WAL and vacuum SQLite store
0 3 * * * sqlite3 /data/jantra/projects/jantra.sqlite "PRAGMA wal_checkpoint(TRUNCATE);"
```

---

## 3. Historical Backup Rotation Runbook

Backups (e.g., Litestream replication, volume snapshots, nightly S3 dumps) preserve historical snapshots of the database. Even after leads are permanently deleted in the live database, historical backup archives will contain the data until those backup snapshots expire.

### Backup Retention Policy
1. **Max Backup Lifetime:** Retain operational database backups for a maximum of 30 days (matching `JANTRA_LEAD_RETENTION_DAYS=30`).
2. **Automated Purging:** All backup artifacts older than the retention threshold must be automatically deleted by storage lifecycle rules.

### S3 / Cloud Storage Lifecycle Rules (Example)
```json
{
  "Rules": [
    {
      "ID": "JantraDatabaseBackupRotation",
      "Status": "Enabled",
      "Filter": {
        "Prefix": "backups/sqlite/"
      },
      "Expiration": {
        "Days": 30
      }
    }
  ]
}
```

### Litestream Replication Expiration
If using Litestream for continuous SQLite streaming replication:
```yaml
# litestream.yml
dbs:
  - path: /data/jantra/projects/jantra.sqlite
    replicas:
      - type: s3
        bucket: jantra-db-backups
        path: db
        retention: 720h # 30 days
```

---

## 4. Audit & Verification Checklist for Operators

- [ ] Verify `JANTRA_ENABLE_LEAD_DELETION_SWEEP` is only enabled in production after partner and notification acceptance.
- [ ] Verify manual sweep endpoint `POST /v1/leads/sweep` derives tenant identity from authenticated caller and does not accept `clientId` in body.
- [ ] Inspect raw SQL (`select * from leads where id = ?`) to verify deleted records cannot be retrieved.
- [ ] Inspect `lead_deletions` table to confirm minimal non-personal records (`id, client_id, lead_id, run_id, deleted_at, action`).
- [ ] Inspect `lead_deletion_requests` queue for any `failed` requests requiring operator review.
- [ ] Ensure WAL checkpointing runs after daily retention sweeps.
- [ ] Verify backup bucket lifecycle rules purge database snapshots older than 30 days.
