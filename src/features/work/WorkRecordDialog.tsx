import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { STATUS_LABELS_ZH, WORK_STATUSES } from '@/domain/status';
import type { WorkStatus } from '@/domain/status';
import type { BusinessCategory, WorkGroup, WorkRecord } from '@/domain/types';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  fieldControlClass,
  fieldRowClass,
} from '@/components/common';
import { DateValueInput } from '@/components/common/DateValueInput';
import { draftFromRecord, emptyWorkDraft } from './work-draft';
import type { WorkDraft } from './work-draft';
import styles from './WorkRecordDialog.module.css';

/**
 * Create / edit a work record.
 *
 * Progressive disclosure: title, date and status are always visible; deadlines, counterpart and
 * filing are collapsible sections. The legacy modal rendered all twenty controls at once in a
 * single scroll, including six honour-only fields that were merely `display:none`.
 *
 * Unsaved-change protection is real: closing a dirty form asks first. The legacy dialog discarded
 * silently on backdrop click, on the X, and on Escape — and a long 备注 was a plausible thing to
 * lose that way.
 */

export interface WorkRecordDialogProps {
  readonly open: boolean;
  readonly editing: WorkRecord | null;
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  readonly onSubmit: (draft: WorkDraft) => Promise<void>;
  readonly onClose: () => void;
}

/**
 * The body is mounted only while the dialog is open, so the draft is seeded from `editing` once
 * per open rather than reset from an effect. That removes the extra render pass and the window in
 * which the previous record's values are still on screen.
 */
export function WorkRecordDialog(props: WorkRecordDialogProps): ReactNode {
  if (!props.open) return null;
  return <WorkRecordDialogBody {...props} />;
}

function WorkRecordDialogBody({
  open,
  editing,
  categories,
  groups,
  onSubmit,
  onClose,
}: WorkRecordDialogProps): ReactNode {
  const [draft, setDraft] = useState<WorkDraft>(() =>
    editing ? draftFromRecord(editing) : emptyWorkDraft(),
  );
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const longTermId = useId();

  const patch = <K extends keyof WorkDraft>(key: K, value: WorkDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const attemptClose = (): void => {
    if (dirty && !saving) setConfirmDiscard(true);
    else onClose();
  };

  const submit = async (): Promise<void> => {
    if (draft.title.trim() === '') {
      setError('请填写事项名称。');
      titleRef.current?.focus();
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await onSubmit({ ...draft, title: draft.title.trim() });
      setDirty(false);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败，请重试。');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog
        open={open}
        title={editing ? '编辑工作记录' : '新增工作记录'}
        size="lg"
        busy={saving}
        onClose={attemptClose}
        initialFocusRef={titleRef}
        footer={
          <>
            <Button variant="secondary" onClick={attemptClose} disabled={saving}>
              取消
            </Button>
            <Button variant="primary" busy={saving} onClick={() => void submit()}>
              保存
            </Button>
          </>
        }
      >
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <p className={styles.requiredNote}>带 * 的字段为必填项。</p>

          <Field label="事项" required error={error}>
            {({ id, describedBy, invalid, required }) => (
              <textarea
                ref={titleRef}
                id={id}
                className={fieldControlClass}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                required={required}
                rows={2}
                value={draft.title}
                onChange={(event) => {
                  patch('title', event.target.value);
                }}
              />
            )}
          </Field>

          <div className={fieldRowClass}>
            <DateValueInput
              legend="事项日期"
              value={draft.occurredOn}
              onChange={(next) => {
                patch('occurredOn', next);
              }}
              hint="记录归入年/月统计与日历的依据。"
            />
            <div className={styles.stack}>
              <Field label="状态">
                {({ id }) => (
                  <select
                    id={id}
                    className={fieldControlClass}
                    value={draft.status}
                    onChange={(event) => {
                      patch('status', event.target.value as WorkStatus);
                    }}
                  >
                    {WORK_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {STATUS_LABELS_ZH[status]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              {/*
                The explanatory sentence is referenced with aria-describedby rather than nested in
                the label. Inside the label it would become part of the checkbox's accessible
                name — verbose to hear, and it made the name contain unrelated words ("状态") that
                collided with other controls.
              */}
              <div className={styles.checkRow}>
                <input
                  id={longTermId}
                  type="checkbox"
                  checked={draft.longTerm}
                  aria-describedby={`${longTermId}-hint`}
                  onChange={(event) => {
                    patch('longTerm', event.target.checked);
                  }}
                />
                <div>
                  <label htmlFor={longTermId} className={styles.checkLabel}>
                    长期推进事项
                  </label>
                  <p className={styles.checkHint} id={`${longTermId}-hint`}>
                    仍按状态判定完成；有具体时限时照常参与逾期计算。
                  </p>
                </div>
              </div>
            </div>
          </div>

          <Field label="完成要求" hint="要交付什么，例如「填报表格」「意见反馈函」。">
            {({ id, describedBy }) => (
              <input
                id={id}
                className={fieldControlClass}
                aria-describedby={describedBy}
                type="text"
                value={draft.requirement}
                onChange={(event) => {
                  patch('requirement', event.target.value);
                }}
              />
            )}
          </Field>

          <details className={styles.section} open>
            <summary className={styles.summary}>时限</summary>
            <div className={fieldRowClass}>
              <DateValueInput
                legend="要求上报时限"
                value={draft.reportDeadline}
                onChange={(next) => {
                  patch('reportDeadline', next);
                }}
                hint="对外报送、反馈意见的时限。"
              />
              <DateValueInput
                legend="完成时限（内部）"
                value={draft.completionDeadline}
                onChange={(next) => {
                  patch('completionDeadline', next);
                }}
                hint="内部拟制、材料完成的时限。"
              />
            </div>
            <DateValueInput
              legend="完成时间"
              allowRange={false}
              value={draft.completedOn}
              onChange={(next) => {
                patch('completedOn', next);
              }}
              textPlaceholder="如：5月13日上传 / 每月例行"
              hint="实际完成的时间；原始文字描述会原样保留。"
            />
          </details>

          <details className={styles.section}>
            <summary className={styles.summary}>对接信息</summary>
            <div className={fieldRowClass}>
              <Field label="对接单位">
                {({ id }) => (
                  <input
                    id={id}
                    className={fieldControlClass}
                    type="text"
                    value={draft.counterpartUnit}
                    onChange={(event) => {
                      patch('counterpartUnit', event.target.value);
                    }}
                  />
                )}
              </Field>
              <Field label="对接人">
                {({ id }) => (
                  <input
                    id={id}
                    className={fieldControlClass}
                    type="text"
                    value={draft.counterpartContact}
                    onChange={(event) => {
                      patch('counterpartContact', event.target.value);
                    }}
                  />
                )}
              </Field>
            </div>
            <Field label="联系方式" hint="按文本保存，不做任何格式改写；可含分机、多个号码。">
              {({ id, describedBy }) => (
                <input
                  id={id}
                  className={fieldControlClass}
                  aria-describedby={describedBy}
                  type="text"
                  inputMode="tel"
                  autoComplete="off"
                  value={draft.counterpartPhone}
                  onChange={(event) => {
                    patch('counterpartPhone', event.target.value);
                  }}
                />
              )}
            </Field>
          </details>

          <details className={styles.section}>
            <summary className={styles.summary}>归类与备注</summary>
            <div className={fieldRowClass}>
              <Field label="业务分类">
                {({ id }) => (
                  <select
                    id={id}
                    className={fieldControlClass}
                    value={draft.categoryId ?? ''}
                    onChange={(event) => {
                      patch('categoryId', event.target.value === '' ? null : event.target.value);
                    }}
                  >
                    <option value="">未分类</option>
                    {categories
                      .filter((category) => !category.archived || category.id === draft.categoryId)
                      .map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
              <Field label="归属分组">
                {({ id }) => (
                  <select
                    id={id}
                    className={fieldControlClass}
                    value={draft.groupId ?? ''}
                    onChange={(event) => {
                      patch('groupId', event.target.value === '' ? null : event.target.value);
                    }}
                  >
                    <option value="">未分组</option>
                    {groups
                      .filter((group) => !group.archived || group.id === draft.groupId)
                      .map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name}
                        </option>
                      ))}
                  </select>
                )}
              </Field>
            </div>
            <Field label="备注">
              {({ id }) => (
                <textarea
                  id={id}
                  className={fieldControlClass}
                  rows={4}
                  value={draft.remark}
                  onChange={(event) => {
                    patch('remark', event.target.value);
                  }}
                />
              )}
            </Field>
          </details>
        </form>
      </Dialog>

      <ConfirmDialog
        open={confirmDiscard}
        title="放弃未保存的修改？"
        body="这条记录有未保存的修改。关闭后这些修改会丢失。"
        confirmLabel="放弃修改"
        cancelLabel="继续编辑"
        onCancel={() => {
          setConfirmDiscard(false);
        }}
        onConfirm={() => {
          setConfirmDiscard(false);
          onClose();
        }}
      />
    </>
  );
}
