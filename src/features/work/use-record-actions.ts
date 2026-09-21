import { useCallback } from 'react';
import { useRefresh } from '@/app/store/data-store';
import { useToast } from '@/components/common';
import {
  addProgressEntry,
  createHonorRecord,
  createWorkRecord,
  deleteProgressEntry,
  purgeRecord,
  restoreRecord,
  softDeleteRecord,
  updateProgressEntry,
  updateRecord,
} from '@/db/repositories/records';
import type { HonorDraft } from '@/features/honors/honor-draft';
import type { WorkDraft } from './work-draft';

/**
 * Record mutations, wired to a refresh and a user-visible outcome.
 *
 * Every action here reports both success and failure. A silent catch is exactly how the legacy
 * prototype lost writes — `loadData()` swallowed its errors into `console.error` and carried on
 * with whatever it had.
 */

export interface RecordActions {
  readonly saveWork: (draft: WorkDraft, editingId: string | null) => Promise<void>;
  readonly saveHonor: (draft: HonorDraft, editingId: string | null) => Promise<void>;
  readonly setStatus: (id: string, status: WorkDraft['status']) => Promise<void>;
  readonly trash: (id: string, title: string) => Promise<void>;
  readonly restore: (id: string) => Promise<void>;
  readonly purge: (id: string) => Promise<void>;
  readonly addProgress: (recordId: string, note: string) => Promise<void>;
  readonly editProgress: (id: string, note: string) => Promise<void>;
  readonly removeProgress: (id: string) => Promise<void>;
}

export function useRecordActions(): RecordActions {
  const refresh = useRefresh();
  const toast = useToast();

  const run = useCallback(
    async (operation: () => Promise<void>, success: string): Promise<void> => {
      try {
        await operation();
        await refresh();
        toast.show(success, 'success');
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        toast.show(`操作失败：${message}`, 'error');
        // Rethrow so a form can keep the dialog open and show the error inline.
        throw cause;
      }
    },
    [refresh, toast],
  );

  const saveWork = useCallback(
    async (draft: WorkDraft, editingId: string | null): Promise<void> => {
      await run(
        async () => {
          if (editingId === null) {
            await createWorkRecord({ ...draft, statusLabel: '' });
          } else {
            await updateRecord(editingId, draft);
          }
        },
        editingId === null ? '已新增工作记录。' : '已保存修改。',
      );
    },
    [run],
  );

  const saveHonor = useCallback(
    async (draft: HonorDraft, editingId: string | null): Promise<void> => {
      await run(
        async () => {
          if (editingId === null) await createHonorRecord(draft);
          else await updateRecord(editingId, draft);
        },
        editingId === null ? '已新增荣誉记录。' : '已保存修改。',
      );
    },
    [run],
  );

  const setStatus = useCallback(
    async (id: string, status: WorkDraft['status']): Promise<void> => {
      await run(async () => {
        await updateRecord(id, { status });
      }, '已更新状态。');
    },
    [run],
  );

  const trash = useCallback(
    async (id: string, title: string): Promise<void> => {
      await run(async () => {
        await softDeleteRecord(id);
      }, `「${title}」已移入回收站，可在「设置 → 回收站」恢复。`);
    },
    [run],
  );

  const restore = useCallback(
    async (id: string): Promise<void> => {
      await run(async () => {
        await restoreRecord(id);
      }, '已恢复记录。');
    },
    [run],
  );

  /*
   * Permanent deletion reports its relational consequence.
   *
   * Detaching an honour's link is a change to a record the user did not select, so it is named in the
   * toast rather than left to be discovered later. The Trash dialog states the same count *before*
   * the action, from the same live snapshot.
   */
  const purge = useCallback(
    async (id: string): Promise<void> => {
      let detached = 0;
      await run(async () => {
        const outcome = await purgeRecord(id);
        detached = outcome.honorsDetached;
      }, '已彻底删除。');
      if (detached > 0) {
        toast.show(
          `已解除 ${String(detached)} 条荣誉记录与该工作事项的关联（荣誉本身已保留）。`,
          'info',
        );
      }
    },
    [run, toast],
  );

  const addProgress = useCallback(
    async (recordId: string, note: string): Promise<void> => {
      await run(async () => {
        await addProgressEntry({ recordId, note });
      }, '已追加进展。');
    },
    [run],
  );

  const editProgress = useCallback(
    async (id: string, note: string): Promise<void> => {
      await run(async () => {
        await updateProgressEntry(id, { note });
      }, '已保存进展。');
    },
    [run],
  );

  const removeProgress = useCallback(
    async (id: string): Promise<void> => {
      await run(async () => {
        await deleteProgressEntry(id);
      }, '已删除该条进展。');
    },
    [run],
  );

  return {
    saveWork,
    saveHonor,
    setStatus,
    trash,
    restore,
    purge,
    addProgress,
    editProgress,
    removeProgress,
  };
}
