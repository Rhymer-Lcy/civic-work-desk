import { useState } from 'react';
import type { ReactNode } from 'react';
import { useRefresh } from '@/app/store/data-store';
import { saveSettings } from '@/db/repositories/taxonomy';
import { DEFAULT_APP_SUBTITLE, DEFAULT_APP_TITLE } from '@/domain/defaults';
import type { AppSettings } from '@/domain/types';
import { Button, Card, Field, fieldControlClass, useToast } from '@/components/common';
import styles from './SettingsPage.module.css';

/**
 * Product wording and reminder cadence.
 *
 * The Chinese product title stays configurable, defaulting to the legacy `<title>`'s
 * `政务工作记录台`. The legacy `<h1>` said `政务工作记录台（离线版）`, but the parenthetical described a
 * `file://` deployment mode this build deliberately no longer supports, so the shorter form is
 * the authoritative default. See docs/decisions/0001-pwa-first.md.
 */
/**
 * Seeded from the saved settings once. The parent keys this section on the saved values, so a
 * successful save remounts it with the new ones — no effect that would also clobber a field the
 * user is mid-way through editing.
 */
export function AppearanceSection({ settings }: { readonly settings: AppSettings }): ReactNode {
  const refresh = useRefresh();
  const toast = useToast();
  const [title, setTitle] = useState(settings.appTitle);
  const [subtitle, setSubtitle] = useState(settings.appSubtitle);
  const [reminderDays, setReminderDays] = useState(String(settings.backupReminderDays));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const dirty =
    title !== settings.appTitle ||
    subtitle !== settings.appSubtitle ||
    reminderDays !== String(settings.backupReminderDays);

  const save = async (next: AppSettings): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      await saveSettings(next);
      await refresh();
      toast.show('已保存应用信息。', 'success');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card
      title="应用信息"
      description="标题与副标题显示在顶栏与导出的报告中。"
      actions={
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            setTitle(DEFAULT_APP_TITLE);
            setSubtitle(DEFAULT_APP_SUBTITLE);
            setReminderDays('7');
          }}
        >
          恢复默认文字
        </Button>
      }
    >
      <div className={styles.grid}>
        <Field label="应用标题" required error={error}>
          {({ id, describedBy, invalid, required }) => (
            <input
              id={id}
              className={fieldControlClass}
              aria-describedby={describedBy}
              aria-invalid={invalid}
              required={required}
              type="text"
              maxLength={80}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="副标题">
          {({ id }) => (
            <input
              id={id}
              className={fieldControlClass}
              type="text"
              maxLength={160}
              value={subtitle}
              onChange={(event) => {
                setSubtitle(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="备份提醒间隔（天）" hint="超过该天数未导出 JSON 备份时，概览页会提示。">
          {({ id, describedBy }) => (
            <input
              id={id}
              className={fieldControlClass}
              aria-describedby={describedBy}
              type="number"
              min={1}
              max={365}
              step={1}
              value={reminderDays}
              onChange={(event) => {
                setReminderDays(event.target.value);
              }}
            />
          )}
        </Field>
      </div>
      <div className={styles.addRow}>
        <Button
          variant="primary"
          busy={busy}
          disabled={!dirty}
          onClick={() => {
            const days = Number(reminderDays);
            if (title.trim() === '') {
              setError('标题不能为空。');
              return;
            }
            if (!Number.isInteger(days) || days < 1 || days > 365) {
              setError('备份提醒间隔需为 1 到 365 之间的整数。');
              return;
            }
            void save({
              ...settings,
              appTitle: title.trim(),
              appSubtitle: subtitle,
              backupReminderDays: days,
            });
          }}
        >
          保存
        </Button>
        {dirty ? <p className={styles.note}>有未保存的修改。</p> : null}
      </div>
    </Card>
  );
}
