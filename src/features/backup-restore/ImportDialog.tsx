import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
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
import { ImportPreview } from './ImportPreview';
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
  /**
   * Destination taxonomy ids.
   *
   * The planner evaluates an incoming record's category and group against the **projected** final
   * taxonomy — the destination's plus whatever the file adds — so a merge can neither skip a valid
   * record nor write one whose reference would not resolve afterwards.
   */
  readonly existingCategoryIds: readonly string[];
  readonly existingGroupIds: readonly string[];
  readonly onClose: () => void;
}

export function ImportDialog({
  open,
  existing,
  existingProgressIds,
  existingCategoryIds,
  existingGroupIds,
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
      setPlan(
        await buildImportPlan({
          parsed,
          mode,
          existing,
          existingProgressIds,
          existingCategoryIds,
          existingGroupIds,
        }),
      );
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
              {confirmButtonLabel(plan)}
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
            {/*
              A v1 archive cannot prove it is complete: the format had no completeness field, and
              the build that wrote it could drop invalid rows without recording anything. Saying so
              at the point of destruction is the difference between an informed decision and a
              surprise.
            */}
            {plan?.requiresCompletenessAcknowledgement === true ? (
              <>
                {' '}
                <strong>
                  注意：这是旧版（v1）备份，无法确认其完整性——当时的格式没有完整性声明，
                  写出它的版本也可能已静默丢弃损坏的数据行。还原后请核对记录条数。
                </strong>
              </>
            ) : null}
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

/**
 * The confirm button names what will actually happen.
 *
 * A canonical restore that cannot be exact — an incomplete archive, or one whose relations do not
 * resolve — must not be labelled 完整还原 even while the action is blocked: the label is the last
 * thing the user reads before committing, and it is the one place the promise is stated in two
 * words. The plan already decided this; the button only renders the decision.
 */
function confirmButtonLabel(plan: ImportPlan | null): string {
  if (!plan) return '导入';
  if (plan.strategy === 'merge') return '合并导入';
  if (plan.strategy === 'legacy-replace') return '替换记录与进展';
  if (!plan.exactRestorePossible) return '无法完整还原';
  return plan.completeness === 'unknown-legacy' ? '还原（完整性未知）' : '完整还原';
}
