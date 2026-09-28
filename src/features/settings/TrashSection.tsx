import { useState } from 'react';
import type { ReactNode } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useRefresh } from '@/app/store/data-store';
import { purgeAllDeleted } from '@/db/repositories/records';
import { sameBatchDescendants } from '@/db/repositories/work-hierarchy';
import { formatDateValue } from '@/domain/dates';
import { WORK_LEVEL_LABELS_ZH, descendantsOf, findHierarchyError } from '@/domain/hierarchy';
import { describePath, hierarchyContext, indexRecords } from '@/domain/hierarchy-summary';
import { primaryDate } from '@/domain/types';
import type { AnyRecord } from '@/domain/types';
import { formatInstant } from '@/utils/clock';
import { Button, Card, ConfirmDialog, EmptyState, Panel, useToast } from '@/components/common';
import { useRecordActions } from '../work/use-record-actions';
import styles from './SettingsPage.module.css';

/**
 * Trash (soft delete).
 *
 * Retention policy: **indefinite until emptied by hand.** No automatic expiry, because a work
 * archive has no natural retention window and a silent background purge would be the worst kind of
 * data loss — invisible and unattributable. The count is shown in Settings so the trash cannot
 * quietly accumulate unnoticed.
 *
 * The legacy `deleteWork()` removed the record from the array and rewrote localStorage
 * immediately, so a mis-click was unrecoverable unless a backup happened to exist.
 */

export function TrashSection({ records }: { readonly records: readonly AnyRecord[] }): ReactNode {
  const actions = useRecordActions();
  const refresh = useRefresh();
  const toast = useToast();
  const [pendingPurge, setPendingPurge] = useState<AnyRecord | null>(null);
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [busy, setBusy] = useState(false);

  const deleted = records
    .filter((record) => record.deletedAt !== null)
    .sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));
  const index = indexRecords(records);

  /*
   * Phase 5: a purge takes a task's descendants with it — never leaves them naming a parent that no
   * longer exists. The confirmation states how many, before anything happens.
   */
  const pendingDescendants =
    pendingPurge !== null && pendingPurge.kind === 'work'
      ? descendantsOf(index, pendingPurge.id)
      : [];

  /*
   * How many honours a permanent deletion would unlink.
   *
   * Permanently deleting a work record preserves any honour that references it and detaches the link
   * (see `purgeRecord`). That is a change to a record the user did not select, so the confirmation
   * must say so before it happens — "do not silently detach relationships without communicating it".
   *
   * An honour that is itself in the trash is going away in the same operation, so it is not counted:
   * nothing survives to be detached.
   */
  const countLinkedHonors = (
    workIds: readonly string[],
    alsoDeletedIds: readonly string[] = [],
  ) => {
    const targets = new Set(workIds);
    const doomed = new Set(alsoDeletedIds);
    return records.filter(
      (record) =>
        record.kind === 'honor' &&
        record.relatedWorkId !== null &&
        targets.has(record.relatedWorkId) &&
        !doomed.has(record.id),
    ).length;
  };

  const pendingDetachCount =
    pendingPurge !== null && pendingPurge.kind === 'work'
      ? countLinkedHonors([pendingPurge.id, ...pendingDescendants.map((record) => record.id)])
      : 0;

  const deletedWorkIds = deleted.filter((record) => record.kind === 'work').map((r) => r.id);
  const emptyTrashDetachCount = countLinkedHonors(
    deletedWorkIds,
    deleted.map((record) => record.id),
  );

  const emptyTrash = async (): Promise<void> => {
    setBusy(true);
    try {
      const outcome = await purgeAllDeleted();
      await refresh();
      toast.show(
        `已彻底删除 ${outcome.recordsPurged} 条记录。` +
          (outcome.honorsDetached > 0
            ? `其中 ${outcome.honorsDetached} 条荣誉记录与工作事项的关联已解除（荣誉本身保留）。`
            : ''),
        'success',
      );
    } catch (cause) {
      const refusal = findHierarchyError(cause);
      toast.show(
        refusal ? refusal.message : cause instanceof Error ? cause.message : String(cause),
        'error',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card
        title={`回收站（${deleted.length}）`}
        description="删除的记录先进入回收站，可以恢复。回收站不会自动清空。"
        actions={
          deleted.length > 0 ? (
            <Button
              size="sm"
              variant="danger"
              icon={<Trash2 size={14} />}
              busy={busy}
              onClick={() => {
                setConfirmEmpty(true);
              }}
            >
              清空回收站
            </Button>
          ) : undefined
        }
      >
        {deleted.length === 0 ? (
          <EmptyState title="回收站是空的" />
        ) : (
          <>
            <Panel tone="info">
              回收站中的记录不出现在任何列表、统计或报告中，但<strong>仍包含在 JSON 备份里</strong>
              ， 以便还原时不丢失。
            </Panel>
            <ul className={styles.list}>
              {deleted.map((record) => (
                <li key={record.id} className={styles.item}>
                  <span className={styles.itemName}>
                    {record.kind === 'work' ? '[工作] ' : '[荣誉] '}
                    {record.title}
                  </span>
                  <span className={styles.itemMeta}>
                    {formatDateValue(primaryDate(record), '无日期')}　删除于{' '}
                    {record.deletedAt ? formatInstant(record.deletedAt) : '—'}
                    {trashContext(index, record)}
                  </span>
                  <div className={styles.itemActions}>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<RotateCcw size={14} />}
                      onClick={() => {
                        void actions.restore(record.id).catch(() => undefined);
                      }}
                    >
                      恢复
                    </Button>
                    <RestoreWithBatch
                      records={records}
                      record={record}
                      onRestore={(id) => {
                        void actions.restoreSubtree(id).catch(() => undefined);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="danger"
                      iconOnly
                      icon={<Trash2 size={14} />}
                      aria-label={`彻底删除：${record.title}`}
                      onClick={() => {
                        setPendingPurge(record);
                      }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      <ConfirmDialog
        open={pendingPurge !== null}
        title="彻底删除这条记录？"
        body={
          <>
            将永久删除 <strong>{pendingPurge?.title ?? ''}</strong>{' '}
            及其全部进展记录。此操作不可撤销。
            {pendingDescendants.length > 0 ? (
              <>
                {' '}
                <strong>
                  它的 {pendingDescendants.length} 项下级任务（含各级）会一并被彻底删除；
                  若其中有不在回收站中的任务，本次删除会被拒绝。
                </strong>
              </>
            ) : null}
            {pendingDetachCount > 0 ? (
              <>
                {' '}
                <strong>
                  另有 {pendingDetachCount} 条荣誉记录关联到该工作事项：荣誉会被保留，
                  但其“关联工作记录”将被清除。
                </strong>
              </>
            ) : null}
          </>
        }
        confirmLabel="彻底删除"
        onCancel={() => {
          setPendingPurge(null);
        }}
        onConfirm={() => {
          const target = pendingPurge;
          const withDescendants = pendingDescendants.length > 0;
          setPendingPurge(null);
          if (!target) return;
          if (withDescendants) void actions.purgeSubtree(target.id).catch(() => undefined);
          else void actions.purge(target.id).catch(() => undefined);
        }}
      />

      <ConfirmDialog
        open={confirmEmpty}
        title="清空回收站？"
        requirePhrase="清空"
        confirmLabel="确认清空"
        busy={busy}
        body={
          <>
            将永久删除回收站中的 <strong>{deleted.length} 条记录</strong>及其进展。此操作不可撤销。
            {emptyTrashDetachCount > 0 ? (
              <>
                {' '}
                <strong>
                  另有 {emptyTrashDetachCount} 条荣誉记录关联到其中的工作事项：荣誉会被保留，
                  但其“关联工作记录”将被清除。
                </strong>
              </>
            ) : null}
          </>
        }
        onCancel={() => {
          setConfirmEmpty(false);
        }}
        onConfirm={() => {
          setConfirmEmpty(false);
          void emptyTrash();
        }}
      />
    </>
  );
}

/** 「 · 2级子任务 · 上级：…」 for a trashed sub-task, so its place in the tree is visible here too. */
function trashContext(index: ReturnType<typeof indexRecords>, record: AnyRecord): string {
  if (record.kind !== 'work') return '';
  const context = hierarchyContext(index, record.id);
  if (context.level === null || context.level === 1) return '';
  return `　·　${WORK_LEVEL_LABELS_ZH[context.level]}　上级：${describePath(context.ancestors)}`;
}

/**
 * 「连同下级一并恢复」, offered when descendants were trashed together with this record — the same
 * `deletedAt` stamp — so that one click undoes exactly that deletion (docs/phase-5 §5).
 */
function RestoreWithBatch({
  records,
  record,
  onRestore,
}: {
  readonly records: readonly AnyRecord[];
  readonly record: AnyRecord;
  readonly onRestore: (id: string) => void;
}): ReactNode {
  if (record.kind !== 'work') return null;
  const batch = sameBatchDescendants(records, record.id).length;
  if (batch === 0) return null;
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<RotateCcw size={14} />}
      onClick={() => {
        onRestore(record.id);
      }}
    >
      连同 {batch} 项下级一并恢复
    </Button>
  );
}
