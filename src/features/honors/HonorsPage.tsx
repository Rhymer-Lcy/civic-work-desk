import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { Award, Link2, Pencil, Plus, Trash2 } from 'lucide-react';
import { useData } from '@/app/store/data-store';
import { formatDateValue } from '@/domain/dates';
import { EMPTY_QUERY, countUndated, distinctUnits, distinctYears, runQuery } from '@/domain/query';
import type { RecordQuery } from '@/domain/query';
import type { HonorRecord } from '@/domain/types';
import { Button, Card, ConfirmDialog, EmptyState, HonorBadge } from '@/components/common';
import { PageHeader } from '@/components/layout/AppShell';
import { FilterBar } from '../work/FilterBar';
import { useRecordActions } from '../work/use-record-actions';
import { HonorRecordDialog } from './HonorRecordDialog';
import type { HonorDraft } from './honor-draft';
import styles from './HonorsPage.module.css';

/**
 * The honours archive.
 *
 * A dedicated view with honour vocabulary throughout — 授予时间 / 级别 / 文号 / 本人角色 /
 * 佐证材料存放 — rather than the legacy treatment, where honours were work cards with a gold
 * border and a `honor-tag` badge, and the honour fields only appeared in an expanded detail grid
 * shared with work records.
 */

export function HonorsPage(): ReactNode {
  const data = useData();
  const actions = useRecordActions();
  const [query, setQuery] = useState<RecordQuery>({ ...EMPTY_QUERY, kind: 'honor' });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<HonorRecord | null>(null);
  const [pendingDelete, setPendingDelete] = useState<HonorRecord | null>(null);

  const results = useMemo(
    () =>
      runQuery(data.records, query, { today: data.today }).filter(
        (record): record is HonorRecord => record.kind === 'honor',
      ),
    [data.records, data.today, query],
  );

  const honorRecords = useMemo(
    () => data.records.filter((record): record is HonorRecord => record.kind === 'honor'),
    [data.records],
  );
  const units = useMemo(() => distinctUnits(honorRecords), [honorRecords]);
  const years = useMemo(() => distinctYears(honorRecords), [honorRecords]);
  const titleById = useMemo(
    () => new Map(data.records.map((record) => [record.id, record.title])),
    [data.records],
  );

  const levels = useMemo(() => {
    const seen = new Set<string>();
    for (const record of honorRecords) {
      if (record.level.trim() !== '') seen.add(record.level.trim());
    }
    return [...seen];
  }, [honorRecords]);

  const openCreate = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  const submit = async (draft: HonorDraft): Promise<void> => {
    await actions.saveHonor(draft, editing?.id ?? null);
  };

  return (
    <>
      <PageHeader
        title="荣誉"
        description="荣誉表彰档案：级别、文号、本人角色与佐证材料存放位置。"
        actions={
          <Button variant="honor" size="lg" icon={<Plus size={18} />} onClick={openCreate}>
            新增荣誉
          </Button>
        }
      />

      <div className={styles.levelRow}>
        <span className={styles.levelLabel}>按级别快速筛选：</span>
        <Button
          size="sm"
          variant={query.honorLevel === null ? 'primary' : 'ghost'}
          onClick={() => {
            setQuery({ ...query, honorLevel: null });
          }}
        >
          全部
        </Button>
        {levels.map((level) => (
          <Button
            key={level}
            size="sm"
            variant={query.honorLevel === level ? 'primary' : 'ghost'}
            onClick={() => {
              setQuery({ ...query, honorLevel: query.honorLevel === level ? null : level });
            }}
          >
            {level}
          </Button>
        ))}
      </div>

      <FilterBar
        query={query}
        onChange={setQuery}
        categories={data.categories}
        groups={data.groups}
        units={units}
        years={years}
        showWorkFilters={false}
        resultCount={results.length}
        undatedCount={countUndated(honorRecords)}
      />

      {results.length === 0 ? (
        <EmptyState
          title="没有符合条件的荣誉记录"
          description="调整筛选条件，或新增一条荣誉。"
          action={
            <Button variant="honor" icon={<Plus size={16} />} onClick={openCreate}>
              新增荣誉
            </Button>
          }
        />
      ) : (
        <ul className={styles.grid}>
          {results.map((record) => (
            <li key={record.id}>
              <Card
                headingLevel={3}
                className={styles.honorCard}
                title={record.title}
                actions={
                  <>
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Pencil size={15} />}
                      aria-label={`编辑荣誉：${record.title}`}
                      onClick={() => {
                        setEditing(record);
                        setDialogOpen(true);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      iconOnly
                      icon={<Trash2 size={15} />}
                      aria-label={`删除荣誉：${record.title}`}
                      onClick={() => {
                        setPendingDelete(record);
                      }}
                    />
                  </>
                }
              >
                <div className={styles.honorBadges}>
                  <HonorBadge level={record.level} />
                  {record.honorType ? (
                    <span className={styles.type}>
                      <Award aria-hidden="true" size={13} />
                      {record.honorType}
                    </span>
                  ) : null}
                </div>
                <dl className={styles.fields}>
                  <HonorField label="授予时间" value={formatDateValue(record.awardedOn)} />
                  <HonorField label="授予单位" value={record.issuingOrg} />
                  <HonorField label="文号 / 编号" value={record.documentNo} />
                  <HonorField label="本人角色" value={record.personalRole} />
                  <HonorField label="佐证材料存放" value={record.evidenceLocation} wide />
                  {record.relatedWorkId ? (
                    <div className={`${styles.field} ${styles.fieldWide}`}>
                      <dt className={styles.fieldLabel}>关联工作事项</dt>
                      <dd className={styles.fieldValue}>
                        <Link2 aria-hidden="true" size={13} />{' '}
                        {titleById.get(record.relatedWorkId) ?? '（该工作记录已删除）'}
                      </dd>
                    </div>
                  ) : null}
                  <HonorField label="备注" value={record.remark} wide />
                </dl>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <HonorRecordDialog
        open={dialogOpen}
        editing={editing}
        options={data.settings.options}
        records={data.records}
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
            将把荣誉 <strong>{pendingDelete?.title ?? ''}</strong> 移入回收站，可在「设置 →
            回收站」恢复。
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

function HonorField({
  label,
  value,
  wide = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly wide?: boolean;
}): ReactNode {
  if (value.trim() === '') return null;
  return (
    <div className={wide ? `${styles.field} ${styles.fieldWide}` : styles.field}>
      <dt className={styles.fieldLabel}>{label}</dt>
      <dd className={styles.fieldValue}>{value}</dd>
    </div>
  );
}
