import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import { ensureSeedData } from '@/db/migrations';
import { addProgressEntry, createHonorRecord, createWorkRecord } from '@/db/repositories/records';
import { listCategories, listGroups } from '@/db/repositories/taxonomy';
import { ABSENT_DATE } from '@/domain/dates';
import { snapshotForBackup } from '@/services/backup';
import { buildEnvelope, serialiseEnvelope } from '@/services/backup/envelope';

/**
 * Generator for `tests/fixtures/phase-1-2-canonical-v3.json`.
 *
 * The compatibility test (`tests/integration/v3-compatibility.test.ts`) must restore an archive
 * **produced by the previous version**, not one this build wrote to its own liking. Hand-writing the
 * shape would only prove the build agrees with itself.
 *
 * ## How the fixture was produced
 *
 * ```bash
 * git worktree add ../p12 48480cf47fc6b9a6f5974de808e39f1576286a46
 * cd ../p12 && npm ci
 * cp <this file> tests/integration/zz-gen.test.ts
 * FIXTURE_OUT=<phase-1.3 tree>/tests/fixtures/phase-1-2-canonical-v3.json \
 *   npx vitest run tests/integration/zz-gen.test.ts
 * ```
 *
 * The destination comes from `FIXTURE_OUT` so that no developer's absolute path is baked into a
 * packaged file (the static security scan rejects one, rightly). Without it the fixture is written
 * relative to the tree the generator runs in, which for a worktree is the worktree's own copy.
 *
 * Run on 2026-09-21 against that commit. The resulting envelope: `backupFormatVersion: 3`,
 * `completeness: "complete"`, `checksum.scope: "envelope"`, 2 records, 1 progress entry, with the
 * honour's `relatedWorkId` pointing at the work record.
 *
 * ## Why the committed fixture is not byte-identical to this script's raw output
 *
 * The repository's format gate covers `.json`, so the generated file was reformatted by Prettier
 * before it was committed. Raw output is `sha256 8bf8b222…`, the committed file is `364b254e…`, and
 * `prettier --write` on the former yields the latter byte for byte — re-verified 2026-09-21 by
 * regenerating in a fresh worktree at the Phase-1.2 commit. Whitespace is outside the envelope
 * digest's scope, so the file still verifies under its own recorded checksum
 * (`fcbb6451ba07f5bb6e0b0a4687b38009a042ee94a1da3204a1ad170209d4b552`); that is what
 * `tests/integration/v3-compatibility.test.ts` asserts.
 *
 * All content is synthetic: placeholder names, a generic unit, and a phone number from the
 * `138-0013-xxxx` documentation block. No real data.
 *
 * Excluded from lint and typecheck (see `eslint.config.js`): it is written against another commit's
 * API surface and belongs to no tsconfig project in this tree.
 */

describe('generate a Phase-1.2 v3 archive fixture', () => {
  beforeEach(async () => {
    const db = createDatabase('p12-gen');
    await db.open();
    await ensureSeedData(db);
    setDatabase(db);
  });

  it('writes it', async () => {
    const categories = await listCategories();
    const groups = await listGroups();
    const work = await createWorkRecord({
      title: '示范工作事项（Phase 1.2 归档）',
      occurredOn: { kind: 'plain', date: '2026-09-01' },
      status: 'in-progress',
      statusLabel: '进行中',
      requirement: '示范完成要求',
      reportDeadline: { kind: 'plain', date: '2026-09-30' },
      completionDeadline: ABSENT_DATE,
      completedOn: ABSENT_DATE,
      categoryId: categories[0]?.id ?? null,
      groupId: groups[0]?.id ?? null,
      longTerm: false,
      counterpartUnit: '示范单位甲',
      counterpartContact: '示范联系人',
      counterpartPhone: '138-0013-8000',
      remark: '示范备注',
    });
    await addProgressEntry({ recordId: work.id, note: '示范进展一' });
    await createHonorRecord({
      title: '示范荣誉（关联工作）',
      awardedOn: { kind: 'plain', date: '2026-06-20' },
      honorType: '表彰（先进集体/个人）',
      level: '市级',
      issuingOrg: '示范颁发单位',
      documentNo: '示范〔2026〕1 号',
      personalRole: '主要完成人',
      evidenceLocation: '示范存放位置',
      relatedWorkId: work.id,
      remark: '',
    });

    const envelope = await buildEnvelope(await snapshotForBackup(), '2026-09-21T13:00:00.000Z');
    expect(envelope.backupFormatVersion).toBe(3);
    expect(envelope.completeness).toBe('complete');
    const out = process.env.FIXTURE_OUT ?? 'tests/fixtures/phase-1-2-canonical-v3.json';
    writeFileSync(out, serialiseEnvelope(envelope), 'utf8');
    // eslint-disable-next-line no-console
    console.log('WROTE', envelope.counts.records, 'records; digest', envelope.checksum.value);
  });
});
