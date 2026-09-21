import { useState } from 'react';
import type { ReactNode } from 'react';
import { RotateCcw, Trash2 } from 'lucide-react';
import { useRefresh } from '@/app/store/data-store';
import { purgeAllDeleted } from '@/db/repositories/records';
import { formatDateValue } from '@/domain/dates';
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

  const emptyTrash = async (): Promise<void> => {
    setBusy(true);
    try {
      const count = await purgeAllDeleted();
      await refresh();
      toast.show(`已彻底删除 ${count} 条记录。`, 'success');
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : String(cause), 'error');
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
          </>
        }
        confirmLabel="彻底删除"
        onCancel={() => {
          setPendingPurge(null);
        }}
        onConfirm={() => {
          const target = pendingPurge;
          setPendingPurge(null);
          if (target) void actions.purge(target.id).catch(() => undefined);
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
