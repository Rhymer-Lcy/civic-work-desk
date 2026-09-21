import type { BusinessCategory, WorkGroup, WorkRecord } from '@/domain/types';
import { businessCategorySchema, workGroupSchema } from '@/domain/validation';
import { newId, nowInstant } from '@/utils/clock';
import { withDatabase, withMutation } from '../client';
import { partitionRows } from '../invalid-row';
import { META_KEY, SETTINGS_KEY } from '../schema';
import type { AppMeta, AppSettings } from '@/domain/types';
import { appSettingsSchema } from '@/domain/validation';
import { defaultSettings } from '@/domain/defaults';

/**
 * Categories, groups, settings and meta.
 *
 * Renaming is safe here in a way it was not in the legacy prototype, which stored the category
 * *name* on each record: `renameBiz()` rewrote `appConfig.biz[i]` and left every record pointing
 * at a name that no longer existed, so the record silently became uncategorised. Records here
 * reference ids, so a rename is a one-row write and nothing is orphaned.
 *
 * Deletion is deliberately not offered for a category still in use. `categoryUsage` reports the
 * count so the UI can require reassignment or archiving instead.
 */

/**
 * Valid categories, sorted.
 *
 * This still drops rows that fail validation, and that is correct **for the UI**: a corrupt category
 * cannot be rendered in a select. What was wrong in Phase 1.1 is that the same convenient shape was
 * also used to build a canonical backup, so corruption became silent absence in an archive the
 * product called complete. Anything that must account for corruption — diagnostics, backups, the
 * recovery export — reads `readStoreSnapshot()` in `../snapshot` instead, which reports the invalid
 * rows rather than filtering them away.
 */
export async function listCategories(): Promise<BusinessCategory[]> {
  return withDatabase('listCategories', async (db) => {
    const rows = await db.categories.toArray();
    return partitionRows(rows, (row) => {
      const parsed = businessCategorySchema.safeParse(row);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, reason: parsed.error.issues[0]?.message ?? 'schema mismatch' };
    }).valid.sort((a, b) => a.sortOrder - b.sortOrder);
  });
}

/** Valid groups, sorted. Same caveat as `listCategories`. */
export async function listGroups(): Promise<WorkGroup[]> {
  return withDatabase('listGroups', async (db) => {
    const rows = await db.groups.toArray();
    return partitionRows(rows, (row) => {
      const parsed = workGroupSchema.safeParse(row);
      return parsed.success
        ? { ok: true, value: parsed.data }
        : { ok: false, reason: parsed.error.issues[0]?.message ?? 'schema mismatch' };
    }).valid.sort((a, b) => a.sortOrder - b.sortOrder);
  });
}

export async function addCategory(name: string): Promise<BusinessCategory> {
  return withMutation('addCategory', ['categories'], async (db) => {
    {
      const existing = await db.categories.toArray();
      const trimmed = name.trim();
      if (existing.some((c) => c.name === trimmed)) {
        throw new Error(`category already exists: ${trimmed}`);
      }
      const category: BusinessCategory = {
        id: newId(),
        name: trimmed,
        sortOrder: existing.length,
        builtIn: false,
        archived: false,
      };
      businessCategorySchema.parse(category);
      await db.categories.add(category);
      return category;
    }
  });
}

export async function renameCategory(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('category name cannot be empty');
  await withMutation('renameCategory', ['categories'], async (db) => {
    const clash = await db.categories.filter((c) => c.name === trimmed && c.id !== id).count();
    if (clash > 0) throw new Error(`category already exists: ${trimmed}`);
    await db.categories.update(id, { name: trimmed });
  });
}

export async function setCategoryArchived(id: string, archived: boolean): Promise<void> {
  await withMutation('setCategoryArchived', ['categories'], async (db) => {
    await db.categories.update(id, { archived });
  });
}

export async function moveCategory(id: string, direction: -1 | 1): Promise<void> {
  await withMutation('moveCategory', ['categories'], async (db) => {
    {
      const ordered = (await db.categories.toArray()).sort((a, b) => a.sortOrder - b.sortOrder);
      const index = ordered.findIndex((c) => c.id === id);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= ordered.length) return;
      const a = ordered[index];
      const b = ordered[target];
      if (!a || !b) return;
      await db.categories.update(a.id, { sortOrder: b.sortOrder });
      await db.categories.update(b.id, { sortOrder: a.sortOrder });
    }
  });
}

/**
 * Delete a category only when nothing references it. Returns false when in use, so the caller
 * can explain why rather than losing the association.
 */
export async function deleteCategoryIfUnused(id: string): Promise<boolean> {
  return withMutation('deleteCategoryIfUnused', ['categories', 'records'], async (db) => {
    {
      const category = await db.categories.get(id);
      if (!category || category.builtIn) return false;
      const used = await db.records.where('categoryId').equals(id).count();
      if (used > 0) return false;
      await db.categories.delete(id);
      return true;
    }
  });
}

export async function categoryUsage(): Promise<ReadonlyMap<string, number>> {
  return withDatabase('categoryUsage', async (db) => {
    const rows = await db.records.toArray();
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.kind !== 'work' || row.deletedAt !== null) continue;
      if (row.categoryId) counts.set(row.categoryId, (counts.get(row.categoryId) ?? 0) + 1);
    }
    return counts;
  });
}

export async function addGroup(name: string): Promise<WorkGroup> {
  return withMutation('addGroup', ['groups'], async (db) => {
    {
      const existing = await db.groups.toArray();
      const trimmed = name.trim();
      if (existing.some((g) => g.name === trimmed)) {
        throw new Error(`group already exists: ${trimmed}`);
      }
      const group: WorkGroup = {
        id: newId(),
        name: trimmed,
        sortOrder: existing.length,
        builtIn: false,
        archived: false,
      };
      workGroupSchema.parse(group);
      await db.groups.add(group);
      return group;
    }
  });
}

export async function renameGroup(id: string, name: string): Promise<void> {
  const trimmed = name.trim();
  if (trimmed === '') throw new Error('group name cannot be empty');
  await withMutation('renameGroup', ['groups'], async (db) => {
    const clash = await db.groups.filter((g) => g.name === trimmed && g.id !== id).count();
    if (clash > 0) throw new Error(`group already exists: ${trimmed}`);
    await db.groups.update(id, { name: trimmed });
  });
}

/**
 * Delete a group, detaching any records that referenced it.
 *
 * Detaching is explicit and reported. The legacy `deleteGroup()` rewrote `w.fixedGroup=''` for
 * every member inside the same click with no indication of how many records it touched.
 */
export async function deleteGroup(id: string): Promise<number> {
  return withMutation('deleteGroup', ['groups', 'records'], async (db) => {
    {
      const group = await db.groups.get(id);
      if (!group || group.builtIn) return 0;
      const members = await db.records.where('groupId').equals(id).toArray();
      const stamp = nowInstant();
      // Read-modify-put rather than a partial `update`: Dexie's UpdateSpec cannot express a patch
      // over a discriminated union, and a whole-row put keeps the record valid by construction.
      for (const member of members) {
        if (member.kind !== 'work') continue;
        const detached: WorkRecord = { ...member, groupId: null, updatedAt: stamp };
        await db.records.put(detached);
      }
      await db.groups.delete(id);
      return members.length;
    }
  });
}

export async function groupUsage(): Promise<ReadonlyMap<string, number>> {
  return withDatabase('groupUsage', async (db) => {
    const rows = await db.records.toArray();
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (row.kind !== 'work' || row.deletedAt !== null) continue;
      if (row.groupId) counts.set(row.groupId, (counts.get(row.groupId) ?? 0) + 1);
    }
    return counts;
  });
}

/* ---------------------------------------------------------------- settings */

export async function getSettings(): Promise<AppSettings> {
  return withDatabase('getSettings', async (db) => {
    const row = await db.settings.get(SETTINGS_KEY);
    if (!row) return defaultSettings();
    const parsed = appSettingsSchema.safeParse(row.value);
    return parsed.success ? parsed.data : defaultSettings();
  });
}

export async function saveSettings(settings: AppSettings): Promise<AppSettings> {
  const validated = appSettingsSchema.parse(settings);
  await withMutation('saveSettings', ['settings'], (db) =>
    db.settings.put({ key: SETTINGS_KEY, value: validated }),
  );
  return validated;
}

export async function getMeta(): Promise<AppMeta | null> {
  return withDatabase('getMeta', async (db) => {
    const row = await db.meta.get(META_KEY);
    return row?.value ?? null;
  });
}

/** What a completed canonical backup knows about itself. */
export interface CanonicalBackupRecord {
  /**
   * The `dataRevision` observed **inside the snapshot transaction** that produced the file.
   *
   * Not "the revision now". See the race below.
   */
  readonly capturedRevision: number | null;
  readonly recordCount: number;
  /** When the file was handed to the browser. */
  readonly at?: string;
}

/**
 * Record that a **complete** canonical JSON backup succeeded.
 *
 * Two invariants live here, and Phase 1.1 satisfied neither fully.
 *
 * **1. The revision recorded is the revision the file contains.** Phase 1.1 wrote
 * `lastBackupRevision: row.value.dataRevision` — the revision current when the *export finished*.
 * The race that makes wrong:
 *
 *   1. the snapshot captures revision R1 and the envelope is built from it;
 *   2. another tab, or the user, mutates data: the counter advances to R2;
 *   3. the export finishes and this function reads the meta row, seeing R2;
 *   4. it records `lastBackupRevision = R2`, so `dataRevision === lastBackupRevision`;
 *   5. backup health reports **fresh** although the file on disk only contains R1.
 *
 * Passing the captured revision in removes the guess. If the store has moved on, the comparison
 * correctly reports stale — `dataRevision` is never rewound to make a file look newer than it is.
 *
 * **2. Only a complete backup may call this at all.** A backup the application itself describes as
 * incomplete (`omittedInvalidRowIds` non-empty) must not establish freshness, because restoring it
 * would not reproduce the database. `createBackup` enforces that; this function is the only writer
 * of canonical backup state, and the caller contract is stated in its name.
 *
 * XLSX and DOCX are reports and never reach here — the legacy prototype's `exportExcel()` wrote its
 * backup marker and silenced the reminder for a week with no backup in existence.
 */
export async function recordCanonicalBackup(entry: CanonicalBackupRecord): Promise<void> {
  await withDatabase('recordCanonicalBackup', (db) =>
    db.transaction('rw', db.meta, async () => {
      const row = await db.meta.get(META_KEY);
      if (!row) return;
      await db.meta.put({
        key: META_KEY,
        value: {
          ...row.value,
          lastBackupAt: entry.at ?? nowInstant(),
          // Deliberately NOT `row.value.dataRevision`.
          lastBackupRevision: entry.capturedRevision,
          lastBackupRecordCount: entry.recordCount,
        },
      });
    }),
  );
}
