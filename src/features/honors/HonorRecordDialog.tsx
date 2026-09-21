import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { AnyRecord, HonorRecord, OptionSets } from '@/domain/types';
import { isWorkRecord } from '@/domain/types';
import {
  Button,
  ConfirmDialog,
  Dialog,
  Field,
  fieldControlClass,
  fieldRowClass,
} from '@/components/common';
import { DateValueInput } from '@/components/common/DateValueInput';
import { draftFromHonor, emptyHonorDraft } from './honor-draft';
import type { HonorDraft } from './honor-draft';
import styles from '../work/WorkRecordDialog.module.css';

/**
 * Create / edit an honour record.
 *
 * Honours get their own form with their own fields. In the legacy prototype an honour was a work
 * record wearing a different badge: the same modal was reused, six honour inputs were revealed by
 * toggling `display`, and irrelevant work controls (完成时限, 是否完成, 归属分组, 长期推进) stayed in
 * the DOM — so an honour could be saved carrying a completion deadline and a long-term flag.
 */

export interface HonorRecordDialogProps {
  readonly open: boolean;
  readonly editing: HonorRecord | null;
  readonly options: OptionSets;
  readonly records: readonly AnyRecord[];
  readonly onSubmit: (draft: HonorDraft) => Promise<void>;
  readonly onClose: () => void;
}

/** Mounted only while open, so the draft is seeded once per open. See WorkRecordDialog. */
export function HonorRecordDialog(props: HonorRecordDialogProps): ReactNode {
  if (!props.open) return null;
  return <HonorRecordDialogBody {...props} />;
}

function HonorRecordDialogBody({
  open,
  editing,
  options,
  records,
  onSubmit,
  onClose,
}: HonorRecordDialogProps): ReactNode {
  const [draft, setDraft] = useState<HonorDraft>(() =>
    editing ? draftFromHonor(editing) : emptyHonorDraft(),
  );
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  const patch = <K extends keyof HonorDraft>(key: K, value: HonorDraft[K]): void => {
    setDraft((current) => ({ ...current, [key]: value }));
    setDirty(true);
  };

  const attemptClose = (): void => {
    if (dirty && !saving) setConfirmDiscard(true);
    else onClose();
  };

  const submit = async (): Promise<void> => {
    if (draft.title.trim() === '') {
      setError('请填写荣誉名称。');
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

  const linkableWork = records.filter(
    (record) => isWorkRecord(record) && record.deletedAt === null,
  );

  return (
    <>
      <Dialog
        open={open}
        title={editing ? '编辑荣誉记录' : '新增荣誉记录'}
        size="lg"
        busy={saving}
        onClose={attemptClose}
        initialFocusRef={titleRef}
        footer={
          <>
            <Button variant="secondary" onClick={attemptClose} disabled={saving}>
              取消
            </Button>
            <Button variant="honor" busy={saving} onClick={() => void submit()}>
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

          <Field label="荣誉名称" required error={error}>
            {({ id, describedBy, invalid, required }) => (
              <input
                ref={titleRef}
                id={id}
                className={fieldControlClass}
                aria-describedby={describedBy}
                aria-invalid={invalid}
                required={required}
                type="text"
                value={draft.title}
                onChange={(event) => {
                  patch('title', event.target.value);
                }}
              />
            )}
          </Field>

          <div className={fieldRowClass}>
            <DateValueInput
              legend="授予时间"
              allowRange={false}
              value={draft.awardedOn}
              onChange={(next) => {
                patch('awardedOn', next);
              }}
            />
            <div className={styles.stack}>
              <OptionField
                label="荣誉类型"
                value={draft.honorType}
                choices={options.honorType}
                onChange={(next) => {
                  patch('honorType', next);
                }}
              />
              <OptionField
                label="级别"
                value={draft.level}
                choices={options.honorLevel}
                onChange={(next) => {
                  patch('level', next);
                }}
              />
            </div>
          </div>

          <div className={fieldRowClass}>
            <Field label="授予单位">
              {({ id }) => (
                <input
                  id={id}
                  className={fieldControlClass}
                  type="text"
                  value={draft.issuingOrg}
                  onChange={(event) => {
                    patch('issuingOrg', event.target.value);
                  }}
                />
              )}
            </Field>
            <Field label="文号 / 编号">
              {({ id }) => (
                <input
                  id={id}
                  className={fieldControlClass}
                  type="text"
                  value={draft.documentNo}
                  onChange={(event) => {
                    patch('documentNo', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <div className={fieldRowClass}>
            <OptionField
              label="本人角色"
              value={draft.personalRole}
              choices={options.personalRole}
              onChange={(next) => {
                patch('personalRole', next);
              }}
            />
            <Field label="佐证材料存放" hint="如：原件存档案柜 3 号盒。">
              {({ id, describedBy }) => (
                <input
                  id={id}
                  className={fieldControlClass}
                  aria-describedby={describedBy}
                  type="text"
                  value={draft.evidenceLocation}
                  onChange={(event) => {
                    patch('evidenceLocation', event.target.value);
                  }}
                />
              )}
            </Field>
          </div>

          <Field label="关联工作事项" hint="可选。关联后在工作记录上也会显示这项荣誉。">
            {({ id, describedBy }) => (
              <select
                id={id}
                className={fieldControlClass}
                aria-describedby={describedBy}
                value={draft.relatedWorkId ?? ''}
                onChange={(event) => {
                  patch('relatedWorkId', event.target.value === '' ? null : event.target.value);
                }}
              >
                <option value="">不关联</option>
                {linkableWork.map((record) => (
                  <option key={record.id} value={record.id}>
                    {record.title}
                  </option>
                ))}
              </select>
            )}
          </Field>

          <Field label="备注">
            {({ id }) => (
              <textarea
                id={id}
                className={fieldControlClass}
                rows={3}
                value={draft.remark}
                onChange={(event) => {
                  patch('remark', event.target.value);
                }}
              />
            )}
          </Field>
        </form>
      </Dialog>

      <ConfirmDialog
        open={confirmDiscard}
        title="放弃未保存的修改？"
        body="这条荣誉记录有未保存的修改。关闭后这些修改会丢失。"
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

/**
 * A select over user-configurable options that also accepts a value not in the list.
 * Migrated records can carry wording no longer offered; silently blanking it would lose data.
 */
function OptionField({
  label,
  value,
  choices,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly choices: readonly string[];
  readonly onChange: (next: string) => void;
}): ReactNode {
  const unlisted = value.trim() !== '' && !choices.includes(value);
  return (
    <Field label={label} hint={unlisted ? '当前取值不在选项列表中，已保留原值。' : undefined}>
      {({ id, describedBy }) => (
        <select
          id={id}
          className={fieldControlClass}
          aria-describedby={describedBy}
          value={value}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="">未标注</option>
          {unlisted ? <option value={value}>{value}（原值）</option> : null}
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
