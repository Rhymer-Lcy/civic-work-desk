import { useCallback, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { usePrimaryAction } from '@/app/primary-action-context';
import { useData } from '@/app/store/data-store';
import { WORK_LEVEL_LABELS_ZH, descendantsOf } from '@/domain/hierarchy';
import {
  buildStructureForest,
  childProgress,
  completionNotice,
  describeChildProgress,
  describePath,
  descendantDeadlines,
  hierarchyContext,
  indexRecords,
} from '@/domain/hierarchy-summary';
import type { WorkIndex } from '@/domain/hierarchy-summary';
import {
  EMPTY_QUERY,
  countUndated,
  distinctUnits,
  distinctYears,
  queryHasFilter,
  runQuery,
} from '@/domain/query';
import type { RecordQuery } from '@/domain/query';
import { isWorkRecord } from '@/domain/types';
import type { ProgressEntry, WorkRecord } from '@/domain/types';
import { readPreference, writePreference } from '@/services/storage/persistence';
import { Card, ConfirmDialog } from '@/components/common';
import { PageHeader, SplitLayout } from '@/components/layout/AppShell';
import { MonthCalendar } from '../calendar/MonthCalendar';
import { FilterBar } from './FilterBar';
import { MoveWorkDialog } from './MoveWorkDialog';
import { TaskStructure } from './TaskStructure';
import { TrashWorkDialog } from './TrashWorkDialog';
import { WorkCard } from './WorkCard';
import type { WorkCardHierarchy } from './WorkCard';
import { WorkRecordDialog } from './WorkRecordDialog';
import type { WorkDraft } from './work-draft';
import { useRecordActions } from './use-record-actions';
import { LoadMore, ViewSwitch, WorkEmptyState } from './WorkPageParts';
import type { WorkView } from './WorkPageParts';
import styles from './WorkPage.module.css';

/**
 * The work list — and, since Phase 5, the task structure.
 *
 * Rendering is windowed with an explicit "load more" rather than the legacy silent 40-row cap.
 * The count line always reports the *full* match count, so a filtered view never looks smaller
 * than it is — the legacy list showed 40 cards with no indication that more existed until the
 * user scrolled.
 *
 * **Two views of one query.** 列表 is the Phase-2 list, unchanged apart from each sub-task naming its
 * level and parent. 任务结构 draws the same `runQuery` result as an outline, adding the ancestors of
 * each match as context. There is no second filter implementation: both views are functions of the
 * one result (docs/phase-5-product-evolution.md §8).
 */

const PAGE_SIZE = 30;

function initialView(): WorkView {
  return readPreference('workView') === 'structure' ? 'structure' : 'list';
}

interface DialogState {
  readonly editing: WorkRecord | null;
  /** The parent a new sub-task will be created under. */
  readonly parent: WorkRecord | null;
}

function cardHierarchy(index: WorkIndex, record: WorkRecord, today: string): WorkCardHierarchy {
  const context = hierarchyContext(index, record.id);
  const below = descendantDeadlines(index, record.id, today);
  return {
    level: context.level,
    path: describePath(context.ancestors),
    parentInTrash: context.parentInTrash?.title ?? null,
    progress: describeChildProgress(childProgress(index, record.id)),
    descendantsOverdue: below.overdue,
    nearestBelow: below.nearest ? `${below.nearest.day}（${below.nearest.title}）` : null,
  };
}

/** The sentence at the top of the record dialog that says where the record sits. */
function hierarchyNoteFor(index: WorkIndex, state: DialogState): string | null {
  if (state.parent) {
    const parentLevel = hierarchyContext(index, state.parent.id).level ?? 1;
    const childLevel = parentLevel + 1;
    const label =
      childLevel === 2 || childLevel === 3 ? WORK_LEVEL_LABELS_ZH[childLevel] : '下级任务';
    return `上级任务：${state.parent.title}（将创建为 ${label}）`;
  }
  if (state.editing) {
    const context = hierarchyContext(index, state.editing.id);
    if (context.level === null || context.level === 1) return null;
    return `${WORK_LEVEL_LABELS_ZH[context.level]}，上级：${describePath(context.ancestors)}。调整层级请使用「调整层级」。`;
  }
  return null;
}

export function WorkPage(): ReactNode {
  const data = useData();
  const actions = useRecordActions();
  const [query, setQuery] = useState<RecordQuery>({ ...EMPTY_QUERY, kind: 'work' });
  const [view, setView] = useState<WorkView>(initialView);
  const [visible, setVisible] = useState(PAGE_SIZE);
  const [dialog, setDialog] = useState<DialogState | null>(null);
  const [moveTarget, setMoveTarget] = useState<WorkRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<WorkRecord | null>(null);
  const [trashChoice, setTrashChoice] = useState<WorkRecord | null>(null);

  const results = useMemo(
    () => runQuery(data.records, query, { today: data.today }).filter(isWorkRecord),
    [data.records, data.today, query],
  );
  const index = useMemo(() => indexRecords(data.records), [data.records]);
  const forest = useMemo(
    () => (view === 'structure' ? buildStructureForest(index, results) : []),
    [view, index, results],
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

  const openCreate = useCallback((): void => {
    setDialog({ editing: null, parent: null });
  }, []);
  usePrimaryAction('新增记录', openCreate);

  const liveWork = useMemo(
    () => data.records.filter((record) => isWorkRecord(record) && record.deletedAt === null),
    [data.records],
  );
  const liveTotal = liveWork.length;

  const chooseView = (next: WorkView): void => {
    setView(next);
    setVisible(PAGE_SIZE);
    writePreference('workView', next);
  };

  const openEdit = (record: WorkRecord): void => {
    setDialog({ editing: record, parent: null });
  };
  const openAddChild = (record: WorkRecord): void => {
    setDialog({ editing: null, parent: record });
  };

  /*
   * Deleting a task with live sub-tasks is never a single click: the user chooses what happens to them
   * (docs/phase-5-product-evolution.md §5). Without sub-tasks the Phase-2 confirmation is unchanged.
   */
  const requestDelete = (record: WorkRecord): void => {
    // The same definition the repository refuses on: any live descendant, at any depth.
    const hasLiveDescendants = descendantsOf(index, record.id).some(
      (descendant) => descendant.deletedAt === null,
    );
    if (hasLiveDescendants) setTrashChoice(record);
    else setPendingDelete(record);
  };

  const submit = async (draft: WorkDraft): Promise<void> => {
    if (!dialog) return;
    await actions.saveWork(draft, dialog.editing?.id ?? null, dialog.parent?.id ?? null);
  };

  const editingId = dialog?.editing?.id ?? null;
  const noticeFor = (draft: WorkDraft): string | null =>
    editingId !== null && draft.status === 'completed' && dialog?.editing?.status !== 'completed'
      ? completionNotice(index, editingId)
      : null;

  const trashChoiceCounts = useMemo(() => {
    if (!trashChoice) return { descendants: 0, children: 0 };
    const live = (record: { readonly deletedAt: string | null }): boolean =>
      record.deletedAt === null;
    return {
      descendants: descendantsOf(index, trashChoice.id).filter(live).length,
      children: (index.children.get(trashChoice.id) ?? []).filter(live).length,
    };
  }, [index, trashChoice]);

  const filtered = queryHasFilter(query);
  const shownCount = view === 'list' ? results.length : forest.length;

  return (
    <>
      <PageHeader title="工作" description="日常工作记录：状态、时限、对接与进展。" />

      {/*
       * Phase 5: the calendar beside the list, adopted from the reference prototype's context column
       * (docs/phase-5-visual-delta.md). It drives the one query's existing day filter, so a selected
       * day appears as the same 日期 chip and clears the same way. Right-hand, as on 概览, and after the
       * list on narrow screens, so it never pushes the work itself down.
       */}
      <SplitLayout
        main={
          <>
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

            <ViewSwitch view={view} onChoose={chooseView} />

            {results.length === 0 ? (
              <WorkEmptyState
                liveTotal={liveTotal}
                onCreate={openCreate}
                onClear={() => {
                  setQuery({ ...EMPTY_QUERY, kind: 'work', sort: query.sort });
                  setVisible(PAGE_SIZE);
                }}
              />
            ) : view === 'structure' ? (
              <>
                {filtered ? (
                  <p className={styles.structureHint}>
                    筛选时显示符合条件的任务及其上级任务；标有「上下文」的上级任务本身未匹配筛选条件。
                  </p>
                ) : null}
                <TaskStructure
                  forest={forest.slice(0, visible)}
                  index={index}
                  today={data.today}
                  filtered={filtered}
                  onEdit={openEdit}
                  onAddChild={openAddChild}
                  onMove={setMoveTarget}
                />
              </>
            ) : (
              <>
                <div className={styles.columns} aria-hidden="true">
                  <span>状态</span>
                  <span>事项</span>
                  <span>业务分类</span>
                  <span>对接单位</span>
                  <span>日期</span>
                  <span className={styles.columnsRight}>时限</span>
                  <span />
                </div>
                <ul className={styles.list}>
                  {results.slice(0, visible).map((record) => (
                    <li key={record.id}>
                      <WorkCard
                        record={record}
                        hierarchy={cardHierarchy(index, record, data.today)}
                        today={data.today}
                        categories={data.categories}
                        groups={data.groups}
                        progress={progressByRecord.get(record.id) ?? []}
                        progressCount={data.progressCountByRecord.get(record.id) ?? 0}
                        onEdit={openEdit}
                        onAddChild={openAddChild}
                        onMove={setMoveTarget}
                        onDelete={requestDelete}
                        onAddProgress={actions.addProgress}
                        onEditProgress={actions.editProgress}
                        onDeleteProgress={actions.removeProgress}
                      />
                    </li>
                  ))}
                </ul>
              </>
            )}

            <LoadMore
              visible={visible}
              total={results.length > 0 ? shownCount : 0}
              unit={view === 'structure' ? ' 个顶层任务' : ''}
              onMore={() => {
                setVisible((value) => value + PAGE_SIZE);
              }}
            />
          </>
        }
        aside={
          <Card
            title="日历"
            headingLevel={3}
            description="点选日期，只看当天的工作；再点一次取消。"
          >
            <MonthCalendar
              records={liveWork}
              selected={query.onDay}
              onSelect={(day) => {
                setQuery({ ...query, onDay: day });
                setVisible(PAGE_SIZE);
              }}
              today={data.today}
            />
          </Card>
        }
      />

      <WorkRecordDialog
        open={dialog !== null}
        editing={dialog?.editing ?? null}
        categories={data.categories}
        groups={data.groups}
        onSubmit={submit}
        onClose={() => {
          setDialog(null);
        }}
        hierarchyNote={dialog ? hierarchyNoteFor(index, dialog) : null}
        {...(dialog?.parent ? { title: '新增下级任务' } : {})}
        completionNotice={noticeFor}
      />

      <MoveWorkDialog
        record={moveTarget}
        index={index}
        onMove={actions.moveWork}
        onClose={() => {
          setMoveTarget(null);
        }}
      />

      <TrashWorkDialog
        record={trashChoice}
        liveDescendants={trashChoiceCounts.descendants}
        liveChildren={trashChoiceCounts.children}
        onCancel={() => {
          setTrashChoice(null);
        }}
        onTrashSubtree={(record) => {
          setTrashChoice(null);
          void actions.trashSubtree(record.id, record.title).catch(() => undefined);
        }}
        onPromoteChildren={(record) => {
          setTrashChoice(null);
          void actions.trashPromotingChildren(record.id, record.title).catch(() => undefined);
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
