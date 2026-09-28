import type { BackupEnvelope, BackupEnvelopeV1 } from './envelope';

/**
 * Record-schema migration for a backup file, separate from the envelope-format migration.
 *
 * Two versions travel in every envelope and they answer different questions:
 *
 * - `backupFormatVersion` — how the **envelope** is laid out (completeness, checksum scope). Still 3:
 *   Phase 5 changed nothing about the envelope, so it is not bumped (docs/phase-5-product-evolution.md
 *   §10.2). `migrateEnvelope` in `./compatibility` handles 1 → 2 → 3.
 * - `schemaVersion` — the shape of the **records** inside the payload. Phase 5 added `parentWorkId` to
 *   work records, which is exactly what this field exists to declare, so it went from 1 to 2.
 *
 * The order is load-bearing: the importer validates a schema-1 file against the schema-1 record shape,
 * verifies its checksum and counts against the file **as received**, and only then calls this. Adding
 * `parentWorkId` first would change the bytes the digest covers and every older file would read as
 * corrupt.
 *
 * The migrated envelope keeps its declared `schemaVersion`, because that is a statement about the file,
 * not about the object this build made from it.
 */
export function migrateEnvelopeRecordsV1ToV2(envelope: BackupEnvelopeV1): BackupEnvelope {
  return {
    ...envelope,
    payload: {
      ...envelope.payload,
      // Schema 1 had no hierarchy, so every work record in it is a top-level task.
      records: envelope.payload.records.map((record) =>
        record.kind === 'work' ? { ...record, parentWorkId: null } : record,
      ),
    },
  };
}
