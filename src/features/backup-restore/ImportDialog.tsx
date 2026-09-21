import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Upload } from 'lucide-react';
import { useRefresh } from '@/app/store/data-store';
import type { AnyRecord } from '@/domain/types';
import { MAX_IMPORT_BYTES, readBackupFile } from '@/services/backup';
import { applyImportPlan } from '@/services/import/apply';
import {
  ImportParseError,
  buildImportPlan,
  planBlockers,
  planWritesAnything,
} from '@/services/import/plan';
import type { ImportMode, ImportPlan } from '@/services/import/plan';
import { Button, ConfirmDialog, Dialog, Panel, useToast } from '@/components/common';
import styles from './ImportDialog.module.css';

/**
 * Restore / import.
 *
 * A three-stage flow — choose file, review the plan, confirm — with nothing written until the last
 * step. The legacy path was one native `confirm()` whose entire content was a row count.
 */

export interface ImportDialogProps {
  readonly open: boolean;
  readonly existing: readonly AnyRecord[];
  /** Destination progress ids, so merge can guarantee it never overwrites an existing note. */
  readonly existingProgressIds: readonly string[];
  readonly onClose: () => void;
}

export function ImportDialog({
  open,
  existing,
  existingProgressIds,
  onClose,
}: ImportDialogProps): ReactNode {
  const refresh = useRefresh();
  const toast = useToast();
  const [mode, setMode] = useState<ImportMode>('merge');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [parseError, setParseError] = useState<{
    message: string;
    details: readonly string[];
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);

  const reset = (): void => {
    setPlan(null);
    setParseError(null);
    setBusy(false);
  };

  const pickFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    setBusy(true);
    setParseError(null);
    setPlan(null);
    try {
      const text = await readBackupFile(file);
      const parsed: unknown = JSON.parse(text);
      setPlan(await buildImportPlan({ parsed, mode, existing, existingProgressIds }));
    } catch (cause) {
      if (cause instanceof ImportParseError) {
        setParseError({ message: cause.message, details: cause.details });
      } else if (cause instanceof SyntaxError) {
        setParseError({ message: '文件不是有效的 JSON，无法解析。', details: [cause.message] });
      } else {
        setParseError({
          message: cause instanceof Error ? cause.message : String(cause),
          details: [],
        });
      }
    } finally {
      setBusy(false);
    }
  };

  const apply = async (): Promise<void> => {
    if (!plan) return;
    setBusy(true);
    try {
      const outcome = await applyImportPlan({ ...plan, mode });
      await refresh();
      toast.show(
        `导入完成：写入 ${outcome.recordsWritten} 条记录、${outcome.progressWritten} 条进展` +
          (outcome.recordsDestroyed > 0 ? `，替换前删除 ${outcome.recordsDestroyed} 条` : '') +
          '。',
        'success',
      );
      reset();
      onClose();
    } catch (cause) {
      toast.show(`导入失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const blockers = plan ? planBlockers({ ...plan, mode }) : [];
  const canApply = plan !== null && blockers.length === 0 && planWritesAnything({ ...plan, mode });

  return (
    <>
      <Dialog
        open={open}
        title="导入 / 还原备份"
        size="lg"
        busy={busy}
        onClose={() => {
          reset();
          onClose();
        }}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={busy}
              onClick={() => {
                reset();
                onClose();
              }}
            >
              取消
            </Button>
            <Button
              variant={mode === 'replace' ? 'danger' : 'primary'}
              busy={busy}
              disabled={!canApply}
              onClick={() => {
                if (mode === 'replace') setConfirmReplace(true);
                else void apply();
              }}
            >
              {plan?.strategy === 'canonical-restore'
                ? '完整还原'
                : plan?.strategy === 'legacy-replace'
                  ? '替换记录与进展'
                  : '合并导入'}
            </Button>
          </>
        }
      >
        <div className={styles.body}>
          <fieldset className={styles.modes}>
            <legend className={styles.legend}>导入方式</legend>
            <label className={styles.mode}>
              <input
                type="radio"
                name="import-mode"
                checked={mode === 'merge'}
                onChange={() => {
                  setMode('merge');
                  setPlan(null);
                }}
              />
              <span>
                <strong>合并</strong>
                <span className={styles.modeHint}>
                  只加入现有数据中不存在的记录。ID 已存在的记录会被跳过并在下方列出，
                  不会覆盖你正在使用的版本。
                </span>
              </span>
            </label>
            <label className={styles.mode}>
              <input
                type="radio"
                name="import-mode"
                checked={mode === 'replace'}
                onChange={() => {
                  setMode('replace');
                  setPlan(null);
                }}
              />
              <span>
                <strong>替换 / 还原</strong>
                <span className={styles.modeHint}>
                  用备份内容取代本机数据。CivicWorkDesk 备份可完整还原（含分类、分组与设置）；
                  旧版格式只能替换记录与进展，分类、分组与设置保持本机现状。
                </span>
              </span>
            </label>
          </fieldset>

          <div className={styles.picker}>
            <label className={styles.fileLabel} htmlFor="import-file">
              选择备份文件（.json）
            </label>
            <input
              id="import-file"
              className={styles.file}
              type="file"
              accept="application/json,.json"
              disabled={busy}
              onChange={(event) => {
                void pickFile(event.target.files?.[0]);
                event.target.value = '';
              }}
            />
            <p className={styles.fileHint}>
              支持本应用的 JSON 备份，以及旧版「工作记录台」导出的
              <code> {'{works: […]}'} </code>、<code>{'{works, honors}'}</code> 与纯数组格式。
              单个文件上限 {Math.round(MAX_IMPORT_BYTES / 1024 / 1024)} MB。
            </p>
          </div>

          {parseError ? (
            <Panel tone="danger">
              <p className={styles.errorTitle}>
                <AlertTriangle aria-hidden="true" size={15} /> {parseError.message}
              </p>
              {parseError.details.length > 0 ? (
                <ul className={styles.errorList}>
                  {parseError.details.map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
            </Panel>
          ) : null}

          {plan ? <ImportPreview plan={plan} blockers={blockers} /> : null}
        </div>
      </Dialog>

      <ConfirmDialog
        open={confirmReplace}
        title="替换全部数据？"
        requirePhrase="替换"
        confirmLabel="确认替换"
        busy={busy}
        body={
          <>
            这会<strong>删除本机全部 {existing.length} 条记录及其进展</strong>， 然后写入备份中的{' '}
            {plan?.accepted.length ?? 0} 条记录。此操作不可撤销。 建议先导出一份当前数据的 JSON
            备份。
          </>
        }
        onCancel={() => {
          setConfirmReplace(false);
        }}
        onConfirm={() => {
          setConfirmReplace(false);
          void apply();
        }}
      />
    </>
  );
}

function ImportPreview({
  plan,
  blockers,
}: {
  readonly plan: ImportPlan;
  readonly blockers: readonly string[];
}): ReactNode {
  const s = plan.summary;
  return (
    <section className={styles.preview} aria-label="导入预览">
      <h3 className={styles.previewTitle}>
        <CheckCircle2 aria-hidden="true" size={15} /> 导入预览（尚未写入）
      </h3>

      <Panel tone={plan.strategy === 'merge' ? 'info' : 'warning'}>
        {STRATEGY_DESCRIPTIONS[plan.strategy]}
      </Panel>

      <dl className={styles.stats}>
        <Stat label="文件格式" value={FORMAT_LABELS[plan.format]} />
        <Stat label="源文件记录数" value={String(s.sourceRows)} />
        <Stat label="将写入工作记录" value={String(s.acceptedWork)} />
        <Stat label="将写入荣誉记录" value={String(s.acceptedHonors)} />
        <Stat label="将写入进展" value={String(s.acceptedProgress)} />
        {plan.strategy === 'merge' ? (
          <Stat label="跳过（ID 已存在）" value={String(s.conflicts)} />
        ) : (
          <Stat label="将被替换的现有记录" value={String(plan.replacesExisting)} />
        )}
        <Stat label="进展 ID 冲突" value={String(s.progressCollisions)} />
        <Stat label="已拒绝" value={String(s.rejected)} />
        <Stat label="迁移提示" value={String(s.warnings)} />
        {plan.checksum !== null ? (
          <Stat label="校验和" value={CHECKSUM_LABELS[plan.checksum]} />
        ) : null}
      </dl>

      {blockers.length > 0 ? (
        <Panel tone="danger">
          <ul className={styles.errorList}>
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {plan.progressCollisions.length > 0 ? (
        <details className={styles.details}>
          <summary>进展 ID 冲突 {plan.progressCollisions.length} 条（不会覆盖现有进展）</summary>
          <ul className={styles.list}>
            {plan.progressCollisions.slice(0, 30).map((collision) => (
              <li key={collision.id}>
                <code>{collision.id}</code>：
                {collision.reason === 'duplicate-in-source'
                  ? '同一文件内重复'
                  : '与本机现有进展 ID 相同'}
                {collision.incomingNote !== '' ? `（${collision.incomingNote.slice(0, 40)}）` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {plan.conflicts.length > 0 ? (
        <details className={styles.details}>
          <summary>
            ID 冲突 {plan.conflicts.length} 条（其中 {s.identicalConflicts} 条与现有记录完全相同）
          </summary>
          <ul className={styles.list}>
            {plan.conflicts.slice(0, 30).map((conflict) => (
              <li key={conflict.id}>
                <code>{conflict.id}</code>：文件「{conflict.incomingTitle}」（
                {conflict.incomingDate}） vs 现有「{conflict.existingTitle}」（
                {conflict.existingDate}）
                {conflict.identical ? ' — 内容相同，跳过无影响' : ' — 内容不同，已保留现有记录'}
              </li>
            ))}
          </ul>
          {plan.conflicts.length > 30 ? (
            <p className={styles.truncated}>仅显示前 30 条，共 {plan.conflicts.length} 条。</p>
          ) : null}
        </details>
      ) : null}

      {plan.rejected.length > 0 ? (
        <details className={styles.details}>
          <summary>已拒绝 {plan.rejected.length} 条</summary>
          <ul className={styles.list}>
            {plan.rejected.slice(0, 30).map((item, index) => (
              <li key={`${item.hint}-${index}`}>
                {item.hint}：{item.reason}
              </li>
            ))}
          </ul>
          {plan.rejected.length > 30 ? (
            <p className={styles.truncated}>仅显示前 30 条，共 {plan.rejected.length} 条。</p>
          ) : null}
        </details>
      ) : null}

      {plan.warnings.length > 0 ? (
        <details className={styles.details}>
          <summary>迁移提示 {plan.warnings.length} 条（不影响导入，供核对）</summary>
          <ul className={styles.list}>
            {plan.warnings.slice(0, 50).map((warning, index) => (
              <li key={`${warning.recordTitle}-${warning.field}-${index}`}>
                <strong>{warning.recordTitle}</strong> · {warning.field}：{warning.message}
                {warning.original !== '' ? `（原值：${warning.original}）` : ''}
              </li>
            ))}
          </ul>
          {plan.warnings.length > 50 ? (
            <p className={styles.truncated}>仅显示前 50 条，共 {plan.warnings.length} 条。</p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

/**
 * What each strategy will actually do, in the user's words.
 *
 * `legacy-replace` must never be described as 完整还原: a legacy file carries no categories, no
 * groups and no settings, so it cannot restore them.
 */
const STRATEGY_DESCRIPTIONS: Readonly<Record<ImportPlan['strategy'], string>> = Object.freeze({
  merge: '合并：只加入本机没有的记录与进展。已存在的 ID 会被跳过，不会覆盖任何现有内容。',
  'canonical-restore':
    '完整还原：本机的记录、进展、业务分类、归属分组与应用设置都将被备份内容取代，' +
    '在同一个事务中完成，失败则整体回滚。',
  'legacy-replace':
    '旧版替换：只替换记录与进展。该格式不包含业务分类、归属分组与应用设置，' +
    '这些内容将保持本机现状——因此这不是一次完整还原。',
});

const FORMAT_LABELS: Readonly<Record<ImportPlan['format'], string>> = Object.freeze({
  'civic-envelope': 'CivicWorkDesk 备份',
  'legacy-versioned': '旧版备份（works）',
  'legacy-split': '旧版备份（works + honors）',
  'legacy-array': '旧版纯数组',
});

const CHECKSUM_LABELS: Readonly<Record<NonNullable<ImportPlan['checksum']>, string>> =
  Object.freeze({
    match: '一致',
    mismatch: '不一致（已阻止导入）',
    absent: '文件未携带校验和',
    unverifiable: '当前环境无法校验',
  });

function Stat({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className={styles.stat}>
      <dt className={styles.statLabel}>{label}</dt>
      <dd className={styles.statValue}>{value}</dd>
    </div>
  );
}

export const IMPORT_ICON = Upload;
