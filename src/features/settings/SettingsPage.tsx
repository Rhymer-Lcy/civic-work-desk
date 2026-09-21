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
      <div className={styles.sections}>
        <AppearanceSection
          key={`${data.settings.appTitle}|${data.settings.appSubtitle}|${String(data.settings.backupReminderDays)}`}
          settings={data.settings}
        />
        <TaxonomySection categories={data.categories} groups={data.groups} records={data.records} />
        <OptionsSection settings={data.settings} />
        <DataSection records={data.records} meta={data.meta} health={data.backupHealth} />
        <InstallSection />
        <DiagnosticsSection
          integrity={data.integrity}
          relationalIssues={data.relationalIssues}
          settings={data.settings}
        />
        <TrashSection records={data.records} />
        <DangerSection recordCount={data.records.length} />
      </div>
    </>
  );
}
