import type { ReactNode } from 'react';
import { MonitorDown } from 'lucide-react';
import { runtimeMode } from '@/app/pwa/service-worker-bridge';
import type { RuntimeMode } from '@/app/pwa/service-worker-bridge';
import { useInstallPrompt } from '@/app/pwa/use-install-prompt';
import { Button, Card, Panel, useToast } from '@/components/common';
import styles from './SettingsPage.module.css';

/**
 * Installation and offline operation.
 *
 * The wording here is deliberately narrower than the legacy version's. That said
 * "本工具为纯本地单文件，不联网也能完整使用" and showed an install button that could never work.
 * This states what the current build actually supports and what it does not — in particular that
 * `file://` is not a supported runtime mode, per docs/decisions/0001-pwa-first.md.
 */

const MODE_LABELS: Readonly<Record<RuntimeMode, string>> = Object.freeze({
  installed: '已作为独立应用运行',
  https: '通过 HTTPS 运行',
  localhost: '通过本机 localhost 运行',
  file: '通过 file:// 直接打开（不受支持）',
  other: '未知运行方式',
});

export function InstallSection(): ReactNode {
  const { availability, promptInstall } = useInstallPrompt();
  const toast = useToast();
  const mode = runtimeMode();

  return (
    <Card
      title="安装与离线使用"
      description="安装后可从桌面或开始菜单直接打开，断网仍可使用已缓存的界面与本机数据。"
      actions={
        availability === 'available' ? (
          <Button
            size="sm"
            variant="primary"
            icon={<MonitorDown size={14} />}
            onClick={() => {
              void promptInstall().then((outcome) => {
                toast.show(
                  outcome === 'accepted'
                    ? '安装已开始。'
                    : outcome === 'dismissed'
                      ? '已取消安装。'
                      : '当前环境不提供安装入口。',
                  outcome === 'accepted' ? 'success' : 'info',
                );
              });
            }}
          >
            安装到桌面
          </Button>
        ) : undefined
      }
    >
      <div className={styles.stat}>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>当前运行方式</span>
          <span className={styles.statValue}>{MODE_LABELS[mode]}</span>
        </div>
        <div className={styles.statRow}>
          <span className={styles.statLabel}>安装入口</span>
          <span className={styles.statValue}>
            {availability === 'installed'
              ? '已安装'
              : availability === 'available'
                ? '可用（见右上按钮）'
                : '当前浏览器未提供自动安装入口'}
          </span>
        </div>
      </div>

      {mode === 'file' ? (
        <Panel tone="danger">
          以 <code>file://</code> 方式打开时，Service Worker、持久化存储申请与安装都不可用，
          IndexedDB 的行为也依浏览器而异。请通过 HTTPS 或本机 <code>localhost</code> 打开本应用。
        </Panel>
      ) : null}

      {availability === 'unavailable' && mode !== 'file' ? (
        <Panel tone="info">
          Firefox 与 Safari 不提供 <code>beforeinstallprompt</code>。
          可使用浏览器菜单中的「安装应用」或「添加到主屏幕 / 程序坞」，功能完全相同。
        </Panel>
      ) : null}

      <Panel tone="info">
        离线缓存只包含界面文件。<strong>工作记录、备份文件与导出的报表都不会进入缓存</strong>，
        它们只存在于本机 IndexedDB 与你自己保存的文件中。
      </Panel>
    </Card>
  );
}
