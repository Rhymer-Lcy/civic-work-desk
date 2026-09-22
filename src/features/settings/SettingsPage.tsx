import type { ReactNode } from 'react';
import { useData } from '@/app/store/data-store';
import { PageHeader } from '@/components/layout/AppShell';
import { AppearanceSection } from './AppearanceSection';
import { DataSection } from './DataSection';
import { DiagnosticsSection } from './DiagnosticsSection';
import { InstallSection } from './InstallSection';
import { OptionsSection } from './OptionsSection';
import { TaxonomySection } from './TaxonomySection';
import { TrashSection } from './TrashSection';
import { DangerSection } from './DangerSection';
import styles from './SettingsPage.module.css';

/**
 * Settings.
 *
 * Ordered so that the most consequential things are last and visually separate. The legacy
 * settings page put "清空全部数据" as the fifth button in a row that began with "导出 Excel", all in
 * the same card, at the same size.
 */
export function SettingsPage(): ReactNode {
  const data = useData();
  return (
    <>
      <PageHeader title="设置" description="应用信息、分类与分组、数据备份、存储诊断与危险操作。" />
      <div className={styles.layout}>
        {/*
         * A section index, not a second navigation.
         *
         * Eight stacked sections in one scroll meant reaching 回收站 from the top was a long journey
         * past thirteen category rows (audit S-1). Plain in-page anchors: they work without
         * JavaScript, they are reachable by keyboard in document order, and they put the wide
         * viewport's spare width to a use that is not decoration. Hidden below 80rem, where the
         * single column is short enough to scroll and the index would just be more to scroll past.
         */}
        <nav className={styles.index} aria-label="设置分区">
          <ul className={styles.indexList}>
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <a className={styles.indexLink} href={`#${section.id}`}>
                  {section.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className={styles.sections}>
          <div id="settings-app" className={styles.anchor}>
            <AppearanceSection
              key={`${data.settings.appTitle}|${data.settings.appSubtitle}|${String(data.settings.backupReminderDays)}`}
              settings={data.settings}
            />
          </div>
          <div id="settings-taxonomy" className={styles.anchor}>
            <TaxonomySection
              categories={data.categories}
              groups={data.groups}
              records={data.records}
            />
          </div>
          <div id="settings-options" className={styles.anchor}>
            <OptionsSection settings={data.settings} />
          </div>
          <div id="settings-data" className={styles.anchor}>
            <DataSection records={data.records} meta={data.meta} health={data.backupHealth} />
          </div>
          <div id="settings-install" className={styles.anchor}>
            <InstallSection />
          </div>
          <div id="settings-diagnostics" className={styles.anchor}>
            <DiagnosticsSection
              integrity={data.integrity}
              relationalIssues={data.relationalIssues}
              settings={data.settings}
            />
          </div>
          <div id="settings-trash" className={styles.anchor}>
            <TrashSection records={data.records} />
          </div>
          <div id="settings-danger" className={styles.anchor}>
            <DangerSection recordCount={data.records.length} />
          </div>
        </div>
      </div>
    </>
  );
}

/**
 * The section index, declared once.
 *
 * The ids are applied by each section's own wrapper below; keeping the list here means the order of
 * the index and the order of the page cannot drift apart.
 */
const SECTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: 'settings-app', label: '应用信息' },
  { id: 'settings-taxonomy', label: '业务分类与分组' },
  { id: 'settings-options', label: '显示选项' },
  { id: 'settings-data', label: '数据与备份' },
  { id: 'settings-install', label: '安装与离线' },
  { id: 'settings-diagnostics', label: '存储与诊断' },
  { id: 'settings-trash', label: '回收站' },
  { id: 'settings-danger', label: '危险操作' },
];
