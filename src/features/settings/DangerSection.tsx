import { useState } from 'react';
import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useRefresh } from '@/app/store/data-store';
import { withDatabase } from '@/db/client';
import { ensureSeedData } from '@/db/migrations';
import { clearAllPreferences } from '@/services/storage/persistence';
import { Button, Card, ConfirmDialog, Panel, useToast } from '@/components/common';
import styles from './SettingsPage.module.css';

/**
 * Destructive operations, structurally separated.
 *
 * One card, red-ruled, last on the page, with a typed confirmation. The legacy "清空全部数据" sat as
 * the fifth button in the same row as "导出 Excel", styled `btn-mini danger` — which was an
 * *outlined brand-red* button, i.e. visually lighter than the primary export button beside it.
 *
 * It was also incomplete: it emptied the record array but left `gov_groups_v1`, `gov_config_v1`,
 * `gov_groups_open`, `gov_work_alert_seen`, `gov_last_backup` and the two migration flags in
 * place, so a "cleared" install still carried state. This version clears every table and every
 * preference key, then re-seeds the defaults in one transaction.
 */

export function DangerSection({ recordCount }: { readonly recordCount: number }): ReactNode {
  const refresh = useRefresh();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const clearEverything = async (): Promise<void> => {
    setBusy(true);
    try {
      await withDatabase('clearAllData', (db) =>
        db.transaction(
          'rw',
          [db.records, db.progressEntries, db.categories, db.groups, db.settings, db.meta],
          async () => {
            await db.records.clear();
            await db.progressEntries.clear();
            await db.categories.clear();
            await db.groups.clear();
            await db.settings.clear();
            await db.meta.clear();
          },
        ),
      );
      clearAllPreferences();
      await withDatabase('reseed', (db) => ensureSeedData(db));
      await refresh();
      toast.show('已清空全部本机数据，并恢复默认分类、分组与设置。', 'success');
    } catch (cause) {
      toast.show(`清空失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Card title="危险操作" className={styles.danger}>
        <Panel tone="danger">
          <p>
            <AlertTriangle aria-hidden="true" size={15} /> <strong>清空全部本机数据</strong>
            ：删除全部 {recordCount} 条记录（含回收站）、全部进展记录、自定义分类与分组、
            全部应用设置与界面偏好，然后恢复出厂默认。此操作不可撤销，
            <strong>请先导出 JSON 备份</strong>。
          </p>
        </Panel>
        <div className={styles.addRow}>
          <Button
            variant="danger"
            busy={busy}
            onClick={() => {
              setConfirming(true);
            }}
          >
            清空全部本机数据
          </Button>
        </div>
      </Card>

      <ConfirmDialog
        open={confirming}
        title="清空全部本机数据？"
        requirePhrase="清空全部数据"
        confirmLabel="确认清空"
        busy={busy}
        body={
          <>
            这会删除本机上的<strong>全部 {recordCount} 条记录</strong>、进展、自定义分类与分组，
            以及全部设置。之后无法恢复，除非你有 JSON 备份。
          </>
        }
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          void clearEverything();
        }}
      />
    </>
  );
}
