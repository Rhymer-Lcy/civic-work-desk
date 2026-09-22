import { writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, setDatabase } from '@/db/client';
import { ensureSeedData } from '@/db/migrations';
import {
  addProgressEntry,
  createHonorRecord,
  createWorkRecord,
  softDeleteRecord,
} from '@/db/repositories/records';
import { addCategory, addGroup, listCategories, listGroups } from '@/db/repositories/taxonomy';
import { BUILT_IN_CATEGORY_IDS, BUILT_IN_GROUP_IDS } from '@/domain/defaults';
import { ABSENT_DATE } from '@/domain/dates';
import type { DateValue } from '@/domain/types';
import { snapshotForBackup } from '@/services/backup';
import { buildEnvelope, serialiseEnvelope } from '@/services/backup/envelope';
import { DEMO_HONORS, DEMO_TODAY, DEMO_WORK } from './demo-dataset';
import type { DemoWork } from './demo-dataset';

/**
 * Generator for `tests/fixtures/demo-dataset.json` — the Phase-2 demo archive.
 *
 * ```bash
 * npx vitest run scripts/fixtures/generate-demo-dataset.test.ts
 * ```
 *
 * ## Why it is generated rather than hand-written
 *
 * The fixture is a **real v3 canonical archive**: schema-valid, relationally consistent, and sealed
 * with its own checksum. Hand-writing 2,000 lines of JSON would mean hand-computing that digest and
 * hand-maintaining the seeded taxonomy, and any drift would fail at import with a checksum error
 * rather than at review. So the dataset is played into a fresh database through the ordinary
 * repository API — the same validation every real record passes — and exported through the ordinary
 * backup path.
 *
 * A consequence worth stating: the fixture cannot contain anything the application would refuse to
 * store. It is demo data, not a test of malformed input; malformed input has its own fixtures.
 *
 * ## Determinism
 *
 * `tests/setup/vitest.setup.ts` pins the clock and the id sequence, so record ids come out as
 * `test-id-0001…` and every `createdAt` is identical between runs. `exportedAt` is passed in
 * explicitly. Two runs therefore produce byte-identical output apart from Prettier's formatting of
 * the committed copy (see the note at the end).
 *
 * Excluded from lint and typecheck (see `eslint.config.js`): it writes files as a side effect and
 * belongs to no tsconfig project in this tree.
 */

const OUT = process.env.DEMO_OUT ?? 'tests/fixtures/demo-dataset.json';

const CATEGORY_KEYS = { ...BUILT_IN_CATEGORY_IDS } as Record<string, string>;
const GROUP_KEYS = { ...BUILT_IN_GROUP_IDS } as Record<string, string>;

/** The one added category and group, so the fixture also exercises non-built-in taxonomy. */
const CUSTOM_CATEGORY = '涉外应急与舆情';
const CUSTOM_GROUP = '对口援建专班';

function dateValue(input: DemoWork['occurred']): DateValue {
  if (typeof input === 'string') return { kind: 'plain', date: input };
  if ('text' in input) return { kind: 'text', text: input.text };
  return { kind: 'range', start: input.start, end: input.end };
}

function plain(date: string | undefined): DateValue {
  return date === undefined ? ABSENT_DATE : { kind: 'plain', date };
}

describe('generate the Phase-2 demo dataset', () => {
  beforeEach(async () => {
    const db = createDatabase('demo-dataset-generator');
    await db.open();
    await ensureSeedData(db);
    setDatabase(db);
  });

  it('writes a sealed v3 archive covering every UI state', async () => {
    const customCategory = await addCategory(CUSTOM_CATEGORY);
    const customGroup = await addGroup(CUSTOM_GROUP);
    CATEGORY_KEYS['custom'] = customCategory.id;
    GROUP_KEYS['custom'] = customGroup.id;

    const createdIds: string[] = [];
    for (const item of DEMO_WORK) {
      const record = await createWorkRecord({
        title: item.title,
        occurredOn: dateValue(item.occurred),
        status: item.status,
        statusLabel: item.statusLabel ?? '',
        requirement: item.requirement ?? '',
        reportDeadline: plain(item.reportDeadline),
        completionDeadline: plain(item.completionDeadline),
        completedOn: plain(item.completedOn),
        categoryId: item.category === undefined ? null : (CATEGORY_KEYS[item.category] ?? null),
        groupId: item.group === undefined ? null : (GROUP_KEYS[item.group] ?? null),
        longTerm: item.longTerm ?? false,
        counterpartUnit: item.unit ?? '',
        counterpartContact: item.contact ?? '',
        counterpartPhone: item.phone ?? '',
        remark: item.remark ?? '',
      });
      createdIds.push(record.id);
      for (const entry of item.progress ?? []) {
        await addProgressEntry({
          recordId: record.id,
          note: entry.note,
          occurredOn: plain(entry.on),
        });
      }
    }

    for (const honor of DEMO_HONORS) {
      await createHonorRecord({
        title: honor.title,
        awardedOn: { kind: 'plain', date: honor.awarded },
        honorType: honor.honorType,
        level: honor.level,
        issuingOrg: honor.issuingOrg,
        documentNo: honor.documentNo ?? '',
        personalRole: honor.personalRole ?? '',
        evidenceLocation: honor.evidenceLocation ?? '',
        relatedWorkId:
          honor.linkedWorkIndex === undefined ? null : (createdIds[honor.linkedWorkIndex] ?? null),
        remark: honor.remark ?? '',
      });
    }

    // Trashed last, so the ids above stay stable whatever is trashed.
    for (const [index, item] of DEMO_WORK.entries()) {
      if (item.trashed === true) await softDeleteRecord(createdIds[index]!);
    }

    const envelope = await buildEnvelope(await snapshotForBackup(), `${DEMO_TODAY}T04:00:00.000Z`);

    // The fixture is only useful if it is a *complete, restorable* archive.
    expect(envelope.backupFormatVersion).toBe(3);
    expect(envelope.completeness).toBe('complete');
    expect(envelope.omittedInvalidRowIds).toEqual([]);
    expect(envelope.counts.workRecords).toBe(DEMO_WORK.length);
    expect(envelope.counts.honorRecords).toBe(DEMO_HONORS.length);
    expect((await listCategories()).length).toBe(13);
    expect((await listGroups()).length).toBe(4);

    writeFileSync(OUT, serialiseEnvelope(envelope), 'utf8');
    // eslint-disable-next-line no-console
    console.log(
      `WROTE ${OUT}: ${envelope.counts.records} records, ` +
        `${envelope.counts.progressEntries} progress entries, digest ${envelope.checksum.value}`,
    );
  });
});
