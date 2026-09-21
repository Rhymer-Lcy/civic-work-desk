import { useState } from 'react';
import type { ReactNode } from 'react';
import { Trash2 } from 'lucide-react';
import { useRefresh } from '@/app/store/data-store';
import { saveSettings } from '@/db/repositories/taxonomy';
import { defaultOptionSets } from '@/domain/defaults';
import type { AppSettings, OptionSets } from '@/domain/types';
import { Button, Card, useToast } from '@/components/common';
import styles from './SettingsPage.module.css';

/**
 * User-editable enumerations for the honour form.
 *
 * Removing an option never rewrites a record that already uses it: the honour form shows an
 * unlisted value as `（原值）` and keeps it. The legacy `deleteOpt()` simply spliced the array,
 * leaving records carrying a value the dropdown no longer offered and no indication of it.
 */

const TABS: readonly { readonly key: keyof OptionSets; readonly label: string }[] = [
  { key: 'honorType', label: '荣誉类型' },
  { key: 'honorLevel', label: '级别' },
  { key: 'personalRole', label: '本人角色' },
];

export function OptionsSection({ settings }: { readonly settings: AppSettings }): ReactNode {
  const refresh = useRefresh();
  const toast = useToast();
  const [tab, setTab] = useState<keyof OptionSets>('honorType');
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const current = settings.options[tab];

  const persist = async (next: readonly string[], message: string): Promise<void> => {
    setBusy(true);
    try {
      await saveSettings({
        ...settings,
        options: { ...settings.options, [tab]: [...next] },
      });
      await refresh();
      toast.show(message, 'success');
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : String(cause), 'error');
    } finally {
      setBusy(false);
    }
  };

  const activeLabel = TABS.find((t) => t.key === tab)?.label ?? '';

  return (
    <Card
      title="下拉选项"
      description="出现在「新增 / 编辑荣誉」表单中。删除选项不会改动已经使用该取值的记录。"
      actions={
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => {
            void (async () => {
              setBusy(true);
              try {
                await saveSettings({ ...settings, options: defaultOptionSets() });
                await refresh();
                toast.show('已恢复默认选项。', 'success');
              } finally {
                setBusy(false);
              }
            })();
          }}
        >
          恢复默认选项
        </Button>
      }
    >
      <div className={styles.tabs} role="tablist" aria-label="选项分组">
        {TABS.map((item) => (
          <Button
            key={item.key}
            size="sm"
            variant={tab === item.key ? 'primary' : 'ghost'}
            role="tab"
            aria-selected={tab === item.key}
            onClick={() => {
              setTab(item.key);
            }}
          >
            {item.label}
          </Button>
        ))}
      </div>

      <ul className={styles.list}>
        {current.length === 0 ? (
          <li className={styles.note}>该分组下还没有选项。</li>
        ) : (
          current.map((option, index) => (
            <li key={option} className={styles.item}>
              <span className={styles.itemName}>{option}</span>
              <div className={styles.itemActions}>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busy || index === 0}
                  onClick={() => {
                    const next = [...current];
                    const previous = next[index - 1];
                    const item = next[index];
                    if (previous === undefined || item === undefined) return;
                    next[index - 1] = item;
                    next[index] = previous;
                    void persist(next, '已调整顺序。');
                  }}
                >
                  上移
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  iconOnly
                  icon={<Trash2 size={14} />}
                  aria-label={`删除${activeLabel}选项：${option}`}
                  disabled={busy}
                  onClick={() => {
                    void persist(
                      current.filter((value) => value !== option),
                      `已删除选项「${option}」。已使用该取值的记录不受影响。`,
                    );
                  }}
                />
              </div>
            </li>
          ))
        )}
      </ul>

      <div className={styles.addRow}>
        <label className="visually-hidden" htmlFor="option-new">
          新的{activeLabel}选项
        </label>
        <input
          id="option-new"
          className={styles.addInput}
          type="text"
          maxLength={40}
          placeholder={`新的${activeLabel}选项`}
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
        />
        <Button
          variant="secondary"
          disabled={busy || draft.trim() === '' || current.includes(draft.trim())}
          onClick={() => {
            const value = draft.trim();
            void persist([...current, value], `已添加选项「${value}」。`).then(() => {
              setDraft('');
            });
          }}
        >
          添加选项
        </Button>
        {current.includes(draft.trim()) && draft.trim() !== '' ? (
          <p className={styles.note}>该选项已存在。</p>
        ) : null}
      </div>
    </Card>
  );
}
