import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Plus } from 'lucide-react';
import { useData } from '@/app/store/data-store';
import { EMPTY_QUERY, countUndated, distinctUnits, distinctYears, runQuery } from '@/domain/query';
import type { RecordQuery } from '@/domain/query';
import { isWorkRecord } from '@/domain/types';
import type { ProgressEntry, WorkRecord } from '@/domain/types';
import { Button, ConfirmDialog, EmptyState } from '@/components/common';
import { PageHeader } from '@/components/layout/AppShell';
import { FilterBar } from './FilterBar';
import { WorkCard } from './WorkCard';
import { WorkRecordDialog } from './WorkRecordDialog';
import type { WorkDraft } from './work-draft';
import { useRecordActions } from './use-record-actions';
import styles from './WorkPage.module.css';

/**
 * The work list.
 *
 * Rendering is windowed with an explicit "load more" rather than the legacy silent 40-row cap.
 * The count line always reports the *full* match count, so a filtered view never looks smaller
 * than it is — the legacy list showed 40 cards with no indication that more existed until the
 * user scrolled.
 */

const PAGE_SIZE = 30;

export function WorkPage(): ReactNode {
  const data = useData();
  const actions = useRecordActions();
  const [query, setQuery] = useState<RecordQuery>({ ...EMPTY_QUERY, kind: 'work' });
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkRecord | null>(null);

  const results = useMemo(
    () => runQuery(data.records, query, { today: data.today }).filter(isWorkRecord),
    [data.records, data.today, query],
  );

  const units = useMemo(() => distinctUnits(data.records), [data.records]);
  const years = useMemo(() => distinctYears(data.records), [data.records]);
  const undated = useMemo(() => countUndated(data.records.filter(isWorkRecord)), [data.records]);

  const progressByRecord = useMemo(() => {
    const map = new Map<string, ProgressEntry[]>();
    for (const entry of data.progress) {
      const list = map.get(entry.recordId) ?? [];
      list.push(entry);
      map.set(entry.recordId, list);
    }
    return map;
  }, [data.progress]);

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const submit = async (draft: WorkDraft): Promise<void> => {
    await actions.saveWork(draft, editing?.id ?? null);
  };

  return (
    <>
      <PageHeader
        title="工作"
        description="日常工作记录：状态、时限、对接与进展。"
        actions={
          <Button variant="primary" size="lg" icon={<Plus size={18} />} onClick={openCreate}>
            新增记录
          </Button>
        }
      />

      <FilterBar
        query={query}
        onChange={(next) => {
          setQuery(next);
          setVisible(PAGE_SIZE);
        }}
        categories={data.categories}
        groups={data.groups}
        units={units}
        years={years}
        resultCount={results.length}
        undatedCount={undated}
      />

      {results.length === 0 ? (
        <EmptyState
          title="没有符合条件的工作记录"
          description="调整筛选条件，或新增一条记录。"
          action={
            <Button variant="primary" icon={<Plus size={16} />} onClick={openCreate}>
              新增记录
            </Button>
          }
        />
      ) : (
        <>
          <ul className={styles.list}>
            {results.slice(0, visible).map((record) => (
              <li key={record.id}>
                <WorkCard
                  record={record}
                  today={data.today}
                  categories={data.categories}
                  groups={data.groups}
                  progress={progressByRecord.get(record.id) ?? []}
                  progressCount={data.progressCountByRecord.get(record.id) ?? 0}
                  onEdit={(target) => {
                    setEditing(target);
                    setDialogOpen(true);
                  }}
                  onDelete={setPendingDelete}
                  onAddProgress={actions.addProgress}
                  onEditProgress={actions.editProgress}
                  onDeleteProgress={actions.removeProgress}
                />
              </li>
            ))}
          </ul>
          {visible < results.length ? (
            <div className={styles.more}>
              <Button
                variant="secondary"
                onClick={() => {
                  setVisible((value) => value + PAGE_SIZE);
                }}
              >
                继续加载（已显示 {visible} / {results.length}）
              </Button>
            </div>
          ) : null}
        </>
      )}

      <WorkRecordDialog
        open={dialogOpen}
        editing={editing}
        categories={data.categories}
        groups={data.groups}
        onSubmit={submit}
        onClose={() => {
          setDialogOpen(false);
          setEditing(null);
        }}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        title="移入回收站？"
        body={
          <>
            将把 <strong>{pendingDelete?.title ?? ''}</strong> 移入回收站。它会从各视图中消失，
            但可以在「设置 → 回收站」中恢复。
          </>
        }
        confirmLabel="移入回收站"
        onCancel={() => {
          setPendingDelete(null);
        }}
        onConfirm={() => {
          const target = pendingDelete;
          setPendingDelete(null);
          if (target) void actions.trash(target.id, target.title).catch(() => undefined);
        }}
      />
    </>
  );
}
