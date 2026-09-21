import { useState } from 'react';
import type { ReactNode } from 'react';
import { Download, FileSpreadsheet, LifeBuoy, Upload } from 'lucide-react';
import { useData, useRefresh } from '@/app/store/data-store';
import type { AnyRecord, AppMeta } from '@/domain/types';
import {
  createBackup,
  createRecoveryExport,
  describeBackupHealth,
  IncompleteBackupError,
} from '@/services/backup';
import type { BackupHealth } from '@/services/backup';
import { downloadBlob } from '@/services/download';
import { filenameStamp, formatInstant } from '@/utils/clock';
import { Button, Card, Panel, useToast } from '@/components/common';
import { ImportDialog } from '../backup-restore/ImportDialog';
import styles from './SettingsPage.module.css';

/**
 * Backup and export.
 *
 * The distinction is stated in the UI, not just in the code: JSON is the backup, XLSX is a report.
 * Only a successful JSON export updates the backup timestamp. In the legacy version
 * `exportExcel()` wrote `gov_last_backup` too, so a spreadsheet silenced the reminder for a week.
 */

export interface DataSectionProps {
  readonly records: readonly AnyRecord[];
  readonly meta: AppMeta | null;
  readonly health: BackupHealth;
}

export function DataSection({ records, meta, health }: DataSectionProps): ReactNode {
  const data = useData();
  const refresh = useRefresh();
  const toast = useToast();
  const [busy, setBusy] = useState<'backup' | 'xlsx' | 'recovery' | null>(null);
  const [incomplete, setIncomplete] = useState<IncompleteBackupError | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const live = records.filter((record) => record.deletedAt === null);
  const work = live.filter((record) => record.kind === 'work').length;
  const honors = live.length - work;

  const runBackup = async (acknowledgeOmissions = false): Promise<void> => {
    setBusy('backup');
    try {
      const result = await createBackup(new Date(), { acknowledgeOmissions });
      // Refresh so the backup-health panel and the "last backup" row reflect the write that
      // `createBackup` just recorded.
      await refresh();
      toast.show(
        `已生成 ${result.download.filename}（${result.envelope.counts.records} 条记录，` +
          `${Math.round(result.download.byteLength / 1024)} KB）。` +
          (result.omitted.length > 0
            ? `注意：该备份缺少 ${String(result.omitted.length)} 行未通过校验的数据，` +
              '不能用于“完整还原”，也不会被记为一次有效备份。'
            : '请确认浏览器已保存该文件。'),
        result.omitted.length > 0 ? 'error' : 'success',
      );
    } catch (cause) {
      if (cause instanceof IncompleteBackupError) {
        // Not a failure to report and forget: the user must choose between exporting evidence
        // first and knowingly accepting an incomplete archive.
        setIncomplete(cause);
        return;
      }
      toast.show(`备份失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const runRecoveryExport = async (): Promise<void> => {
    setBusy('recovery');
    try {
      const result = await createRecoveryExport();
      toast.show(
        `已生成诊断恢复文件 ${result.download.filename}（共 ${String(result.invalidTotal)} 行：` +
          `记录 ${String(result.invalidRecords)}、进展 ${String(result.invalidProgressEntries)}、` +
          `分类 ${String(result.invalidCategories)}、分组 ${String(result.invalidGroups)}、` +
          `设置 ${String(result.invalidSettings)}）。该文件不能用于还原。`,
        'success',
      );
    } catch (cause) {
      toast.show(`导出失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const runXlsx = async (): Promise<void> => {
    setBusy('xlsx');
    try {
      const { buildWorkbook, ledgerFilename } = await import('@/services/export/xlsx');
      const blob = await buildWorkbook({
        records: live,
        categories: data.categories,
        groups: data.groups,
        today: data.today,
        generatedAt: new Date().toISOString(),
      });
      const result = downloadBlob(blob, ledgerFilename(filenameStamp()));
      toast.show(
        `已生成 ${result.filename}（${Math.round(result.byteLength / 1024)} KB）。` +
          'XLSX 是报表，不能用于还原数据。',
        'success',
      );
    } catch (cause) {
      toast.show(`导出失败：${cause instanceof Error ? cause.message : String(cause)}`, 'error');
    } finally {
      setBusy(null);
    }
  };

  const stale = health.state === 'stale' || health.state === 'never';

  return (
    <>
      <Card
        title="数据与备份"
        description="JSON 备份是唯一可以完整还原的格式，包含记录、进展、分类、分组与设置。"
      >
        {stale ? (
          <Panel tone="warning">{describeBackupHealth(health)}</Panel>
        ) : (
          <Panel tone="info">{describeBackupHealth(health)}</Panel>
        )}

        {incomplete ? (
          <Panel tone="danger">
            <p>
              <strong>无法生成完整备份。</strong>
              {incomplete.message}
            </p>
            <p className={styles.note}>
              即使选择“仍要导出”，该文件也会自述为<strong>不完整</strong>：
              它不能用于“完整还原”，也不会被记为一次有效备份。
            </p>
            <p className={styles.note}>
              建议先导出<strong>诊断恢复文件</strong>
              留证（其中按原样保留这些数据行，但不能用于还原）， 再决定是否导出一份
              <strong>不含这些行</strong>的备份。
            </p>
            <div className={styles.addRow}>
              <Button
                variant="primary"
                icon={<LifeBuoy size={16} />}
                busy={busy === 'recovery'}
                onClick={() => void runRecoveryExport()}
              >
                导出诊断恢复文件
              </Button>
              <Button
                variant="danger"
                busy={busy === 'backup'}
                onClick={() => {
                  setIncomplete(null);
                  void runBackup(true);
                }}
              >
                仍要导出（将缺少这些行）
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  setIncomplete(null);
                }}
              >
                取消
              </Button>
            </div>
          </Panel>
        ) : null}

        <div className={styles.addRow}>
          <Button
            variant="primary"
            icon={<Download size={16} />}
            busy={busy === 'backup'}
            onClick={() => void runBackup(false)}
          >
            导出 JSON 备份
          </Button>
          <Button
            variant="secondary"
            icon={<Upload size={16} />}
            onClick={() => {
              setImportOpen(true);
            }}
          >
            导入 / 还原备份
          </Button>
          <Button
            variant="secondary"
            icon={<FileSpreadsheet size={16} />}
            busy={busy === 'xlsx'}
            onClick={() => void runXlsx()}
          >
            导出 XLSX 报表
          </Button>
        </div>

        <div className={styles.stat}>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>当前记录</span>
            <span className={styles.statValue}>
              共 {live.length} 条（工作 {work}，荣誉 {honors}）
            </span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>进展记录</span>
            <span className={styles.statValue}>{data.progress.length} 条</span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>上次 JSON 备份</span>
            <span className={styles.statValue}>
              {meta?.lastBackupAt ? formatInstant(meta.lastBackupAt) : '从未'}
              {meta?.lastBackupRecordCount !== null && meta?.lastBackupRecordCount !== undefined
                ? `（当时 ${meta.lastBackupRecordCount} 条）`
                : ''}
            </span>
          </div>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>数据库架构版本</span>
            <span className={styles.statValue}>v{meta?.schemaVersion ?? '—'}</span>
          </div>
          <p className={styles.note}>
            浏览器不提供「文件已保存」的回执，因此这里只能确认备份文件已生成并交给浏览器下载。
            请在下载目录中确认文件存在，并把它保存到本机以外的位置。
          </p>
        </div>
      </Card>

      <ImportDialog
        open={importOpen}
        existing={records}
        existingProgressIds={data.progress.map((entry) => entry.id)}
        onClose={() => {
          setImportOpen(false);
        }}
      />
    </>
  );
}
