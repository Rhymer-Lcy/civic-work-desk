import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { HardDrive, ShieldCheck } from 'lucide-react';
import { SCHEMA_VERSION } from '@/db/schema';
import type { AppSettings } from '@/domain/types';
import {
  formatBytes,
  readStorageDiagnostics,
  requestPersistentStorage,
} from '@/services/storage/persistence';
import type { StorageDiagnostics } from '@/services/storage/persistence';
import { BACKUP_FORMAT_VERSION } from '@/services/backup';
import { Button, Card, Panel, useToast } from '@/components/common';
import styles from './SettingsPage.module.css';

/**
 * Storage diagnostics and data-integrity reporting.
 *
 * Both halves exist because the legacy product asserted things it had not checked. Its Settings
 * text said "数据只存在你自己电脑的浏览器里" and left it there — nothing about eviction, quota, or what
 * happens when the browser profile is cleared. And when a stored row was malformed, `loadData()`
 * caught the error and continued with a partial dataset, so corruption looked like deletion.
 */

export interface DiagnosticsSectionProps {
  readonly invalidRows: readonly { readonly id: string; readonly reason: string }[];
  readonly settings: AppSettings;
}

export function DiagnosticsSection({ invalidRows, settings }: DiagnosticsSectionProps): ReactNode {
  const toast = useToast();
  const [diagnostics, setDiagnostics] = useState<StorageDiagnostics | null>(null);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void readStorageDiagnostics().then((result) => {
      if (!cancelled) setDiagnostics(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const askForPersistence = async (): Promise<void> => {
    setRequesting(true);
    try {
      const granted = await requestPersistentStorage();
      setDiagnostics(await readStorageDiagnostics());
      toast.show(
        granted === true
          ? '浏览器已授予持久化存储。'
          : granted === false
            ? '浏览器拒绝了持久化请求。数据仍在本机，但在存储紧张时可能被清理。'
            : '当前浏览器不支持该请求。',
        granted === true ? 'success' : 'info',
      );
    } finally {
      setRequesting(false);
    }
  };

  return (
    <Card
      title="存储与数据诊断"
      description="本机存储状态与数据完整性检查。"
      actions={
        diagnostics?.supported === true && diagnostics.persisted !== true ? (
          <Button
            size="sm"
            variant="secondary"
            icon={<ShieldCheck size={14} />}
            busy={requesting}
            onClick={() => void askForPersistence()}
          >
            申请持久化存储
          </Button>
        ) : undefined
      }
    >
      <div className={styles.stat}>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>
            <HardDrive aria-hidden="true" size={13} /> 持久化存储
          </span>
          <span className={styles.statValue}>
            {diagnostics === null
              ? '检测中…'
              : !diagnostics.supported
                ? '当前浏览器不支持 Storage API'
                : diagnostics.persisted === true
                  ? '已授予'
                  : diagnostics.persisted === false
                    ? '未授予'
                    : '未知'}
          </span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>已用 / 配额</span>
          <span className={styles.statValue}>
            {formatBytes(diagnostics?.usageBytes ?? null)} /{' '}
            {formatBytes(diagnostics?.quotaBytes ?? null)}
          </span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>数据库</span>
          <span className={styles.statValue}>
            IndexedDB「civic-work-desk」架构 v{SCHEMA_VERSION}
          </span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>备份格式</span>
          <span className={styles.statValue}>信封 v{BACKUP_FORMAT_VERSION}</span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>备份提醒</span>
          <span className={styles.statValue}>每 {settings.backupReminderDays} 天</span>
        </div>
      </div>

      <Panel tone="info">
        持久化只降低浏览器在存储紧张时清理数据的可能，<strong>不是保证，也不是备份</strong>。
        清理浏览数据、更换设备或重装系统都会导致本机数据消失。唯一可靠的保护是定期导出 JSON 备份
        并保存到本机以外的位置。
      </Panel>

      {invalidRows.length > 0 ? (
        <Panel tone="danger">
          <p>
            <strong>{invalidRows.length} 条记录未通过结构校验</strong>
            ，已从所有列表与统计中排除。系统<strong>没有</strong>自动修改它们。
          </p>
          <ul className={styles.list}>
            {invalidRows.slice(0, 20).map((row) => (
              <li key={row.id} className={styles.note}>
                <code>{row.id}</code>：{row.reason}
              </li>
            ))}
          </ul>
          {/*
            The Phase-1 wording told the user to "export a JSON backup as evidence", which was
            wrong twice over: a canonical backup cannot contain an invalid row, and Phase 1 dropped
            such rows without saying so. The correct procedure names the right file for each job.
          */}
          <p className={styles.note}>
            <strong>处理顺序：</strong>
          </p>
          <ol className={styles.steps}>
            <li>
              在「数据与备份」中导出<strong>诊断恢复文件</strong>
              ——普通 JSON 备份只能包含通过校验的数据行，<strong>无法</strong>作为这些行的证据。
            </li>
            <li>保存好该文件，它按原样保留了未通过校验的数据行，供技术排查使用。</li>
            <li>再以「替换 / 还原」方式导入一份已知良好的 CivicWorkDesk 备份。</li>
          </ol>
          <p className={styles.note}>
            诊断恢复文件<strong>不能</strong>通过「导入 / 还原备份」写回应用。
          </p>
        </Panel>
      ) : (
        <Panel tone="info">全部记录通过结构校验。</Panel>
      )}
    </Card>
  );
}
