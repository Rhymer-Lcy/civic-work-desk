import type { ReactNode } from 'react';
import { CheckCircle2, Upload } from 'lucide-react';
import { describeCompleteness } from '@/services/backup/compatibility';
import type { ImportPlan } from '@/services/import/plan';
import { Panel } from '@/components/common';
import styles from './ImportDialog.module.css';

/**
 * The import preview: everything the plan says will happen, before anything is written.
 *
 * Split out of `ImportDialog.tsx` in Phase 1.2 when that file outgrew its line budget. It reads
 * **only** from the plan — never from the raw file — which is the point: completeness, relational
 * integrity and exactness are decided once in `buildImportPlan` and rendered here. Phase 1.1 had the
 * completeness information in the file and nothing consulted it, so an archive that declared itself
 * incomplete was still offered as 完整还原.
 */

export function ImportPreview({
  plan,
  blockers,
}: {
  readonly plan: ImportPlan;
  readonly blockers: readonly string[];
}): ReactNode {
  const s = plan.summary;
  return (
    <section className={styles.preview} aria-label="导入预览">
      <h3 className={styles.previewTitle}>
        <CheckCircle2 aria-hidden="true" size={15} /> 导入预览（尚未写入）
      </h3>

      <Panel tone={plan.strategy === 'merge' ? 'info' : 'warning'}>
        {STRATEGY_DESCRIPTIONS[plan.strategy]}
      </Panel>

      {/*
        Completeness is read off the plan, never re-derived from the file here. It is the property
        that decides whether an exact restore is even possible, so it is stated before the counts
        rather than buried among them.
      */}
      {plan.completeness !== null ? (
        <Panel tone={plan.completeness === 'complete' ? 'info' : 'warning'}>
          {describeCompleteness(plan.completeness)}
          {plan.checksumScope === 'payload' ? (
            <> 该文件的校验和只覆盖数据本体，不覆盖完整性声明本身（v1/v2 格式所限）。</>
          ) : null}
        </Panel>
      ) : null}

      <dl className={styles.stats}>
        <Stat label="文件格式" value={FORMAT_LABELS[plan.format]} />
        {plan.completeness !== null ? (
          <Stat label="完整性" value={COMPLETENESS_LABELS[plan.completeness]} />
        ) : null}
        <Stat label="源文件记录数" value={String(s.sourceRows)} />
        <Stat label="将写入工作记录" value={String(s.acceptedWork)} />
        <Stat label="将写入荣誉记录" value={String(s.acceptedHonors)} />
        <Stat label="将写入进展" value={String(s.acceptedProgress)} />
        {plan.strategy === 'merge' ? (
          <Stat label="跳过（ID 已存在）" value={String(s.conflicts)} />
        ) : (
          <Stat label="将被替换的现有记录" value={String(plan.replacesExisting)} />
        )}
        <Stat label="进展 ID 冲突" value={String(s.progressCollisions)} />
        <Stat label="引用无法解析" value={String(s.referenceRejections)} />
        <Stat label="进展找不到记录" value={String(s.orphanProgress)} />
        <Stat label="已拒绝" value={String(s.rejected)} />
        <Stat label="迁移提示" value={String(s.warnings)} />
        {plan.checksum !== null ? (
          <Stat label="校验和" value={CHECKSUM_LABELS[plan.checksum]} />
        ) : null}
      </dl>

      {blockers.length > 0 ? (
        <Panel tone="danger">
          <ul className={styles.errorList}>
            {blockers.map((blocker) => (
              <li key={blocker}>{blocker}</li>
            ))}
          </ul>
        </Panel>
      ) : null}

      {plan.progressCollisions.length > 0 ? (
        <details className={styles.details}>
          <summary>进展 ID 冲突 {plan.progressCollisions.length} 条（不会覆盖现有进展）</summary>
          <ul className={styles.list}>
            {plan.progressCollisions.slice(0, 30).map((collision) => (
              <li key={collision.id}>
                <code>{collision.id}</code>：
                {collision.reason === 'duplicate-in-source'
                  ? '同一文件内重复'
                  : '与本机现有进展 ID 相同'}
                {collision.incomingNote !== '' ? `（${collision.incomingNote.slice(0, 40)}）` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {/*
        Rows a merge cannot write without breaking a reference. Reported per row with the reason,
        because the alternatives are worse: rewriting the reference to null would alter the user's data
        silently, and inventing the missing category would invent taxonomy that never existed.
      */}
      {plan.referenceRejections.length > 0 ? (
        <details className={styles.details}>
          <summary>
            引用无法解析 {plan.referenceRejections.length} 条（已跳过，未改写任何引用）
          </summary>
          <ul className={styles.list}>
            {plan.referenceRejections.slice(0, 30).map((rejection) => (
              <li key={rejection.id}>
                <code>{rejection.id}</code>：{rejection.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {plan.orphanProgress.length > 0 ? (
        <details className={styles.details}>
          <summary>进展找不到所属记录 {plan.orphanProgress.length} 条（已跳过）</summary>
          <ul className={styles.list}>
            {plan.orphanProgress.slice(0, 30).map((entry) => (
              <li key={entry.id}>
                <code>{entry.id}</code>：所属记录 <code>{entry.recordId}</code> 导入后仍不存在
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {plan.conflicts.length > 0 ? (
        <details className={styles.details}>
          <summary>
            ID 冲突 {plan.conflicts.length} 条（其中 {s.identicalConflicts} 条与现有记录完全相同）
          </summary>
          <ul className={styles.list}>
            {plan.conflicts.slice(0, 30).map((conflict) => (
              <li key={conflict.id}>
                <code>{conflict.id}</code>：文件「{conflict.incomingTitle}」（
                {conflict.incomingDate}） vs 现有「{conflict.existingTitle}」（
                {conflict.existingDate}）
                {conflict.identical ? ' — 内容相同，跳过无影响' : ' — 内容不同，已保留现有记录'}
              </li>
            ))}
          </ul>
          {plan.conflicts.length > 30 ? (
            <p className={styles.truncated}>仅显示前 30 条，共 {plan.conflicts.length} 条。</p>
          ) : null}
        </details>
      ) : null}

      {plan.rejected.length > 0 ? (
        <details className={styles.details}>
          <summary>已拒绝 {plan.rejected.length} 条</summary>
          <ul className={styles.list}>
            {plan.rejected.slice(0, 30).map((item, index) => (
              <li key={`${item.hint}-${index}`}>
                {item.hint}：{item.reason}
              </li>
            ))}
          </ul>
          {plan.rejected.length > 30 ? (
            <p className={styles.truncated}>仅显示前 30 条，共 {plan.rejected.length} 条。</p>
          ) : null}
        </details>
      ) : null}

      {plan.warnings.length > 0 ? (
        <details className={styles.details}>
          <summary>迁移提示 {plan.warnings.length} 条（不影响导入，供核对）</summary>
          <ul className={styles.list}>
            {plan.warnings.slice(0, 50).map((warning, index) => (
              <li key={`${warning.recordTitle}-${warning.field}-${index}`}>
                <strong>{warning.recordTitle}</strong> · {warning.field}：{warning.message}
                {warning.original !== '' ? `（原值：${warning.original}）` : ''}
              </li>
            ))}
          </ul>
          {plan.warnings.length > 50 ? (
            <p className={styles.truncated}>仅显示前 50 条，共 {plan.warnings.length} 条。</p>
          ) : null}
        </details>
      ) : null}
    </section>
  );
}

/**
 * What each strategy will actually do, in the user's words.
 *
 * `legacy-replace` must never be described as 完整还原: a legacy file carries no categories, no
 * groups and no settings, so it cannot restore them.
 */
const STRATEGY_DESCRIPTIONS: Readonly<Record<ImportPlan['strategy'], string>> = Object.freeze({
  merge: '合并：只加入本机没有的记录与进展。已存在的 ID 会被跳过，不会覆盖任何现有内容。',
  'canonical-restore':
    '完整还原：本机的记录、进展、业务分类、归属分组与应用设置都将被备份内容取代，' +
    '在同一个事务中完成，失败则整体回滚。',
  'legacy-replace':
    '旧版替换：只替换记录与进展。该格式不包含业务分类、归属分组与应用设置，' +
    '这些内容将保持本机现状——因此这不是一次完整还原。',
});

const FORMAT_LABELS: Readonly<Record<ImportPlan['format'], string>> = Object.freeze({
  'civic-envelope': 'CivicWorkDesk 备份',
  'legacy-versioned': '旧版备份（works）',
  'legacy-split': '旧版备份（works + honors）',
  'legacy-array': '旧版纯数组',
});

const CHECKSUM_LABELS: Readonly<Record<NonNullable<ImportPlan['checksum']>, string>> =
  Object.freeze({
    match: '一致',
    mismatch: '不一致（已阻止导入）',
    absent: '文件未携带校验和',
    unverifiable: '当前环境无法校验',
  });

const COMPLETENESS_LABELS: Readonly<Record<NonNullable<ImportPlan['completeness']>, string>> =
  Object.freeze({
    complete: '完整',
    incomplete: '不完整（不能用于完整还原）',
    'unknown-legacy': '未知（旧版 v1 备份）',
  });

function Stat({ label, value }: { readonly label: string; readonly value: string }): ReactNode {
  return (
    <div className={styles.stat}>
      <dt className={styles.statLabel}>{label}</dt>
      <dd className={styles.statValue}>{value}</dd>
    </div>
  );
}

export const IMPORT_ICON = Upload;
