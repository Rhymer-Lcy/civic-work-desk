import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { ChevronDown, Search, SlidersHorizontal, X } from 'lucide-react';
import { EMPTY_QUERY } from '@/domain/query';
import type { RecordQuery, SortKey, StatusBucket } from '@/domain/query';
import { STATUS_LABELS_ZH } from '@/domain/status';
import type { BusinessCategory, WorkGroup } from '@/domain/types';
import { Button } from '@/components/common';
import styles from './FilterBar.module.css';

/**
 * Filter controls.
 *
 * Every control writes into one `RecordQuery`, and the active selections are echoed back as
 * removable chips. The legacy toolbar had six independent `<select>`s plus a search box with no
 * indication of what was active and no way to clear them together — and because the two views had
 * separate filter code, clearing in one did not clear the other.
 */

const STATUS_OPTIONS: readonly { readonly value: StatusBucket; readonly label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'open', label: '未结束' },
  { value: 'todo', label: STATUS_LABELS_ZH.todo },
  { value: 'in-progress', label: STATUS_LABELS_ZH['in-progress'] },
  { value: 'completed', label: STATUS_LABELS_ZH.completed },
  { value: 'deferred', label: STATUS_LABELS_ZH.deferred },
  { value: 'cancelled', label: STATUS_LABELS_ZH.cancelled },
  { value: 'long-term', label: '长期推进' },
  { value: 'overdue', label: '已逾期' },
  { value: 'stale-backlog', label: '历史遗留（逾期 30 天以上）' },
];

const SORT_OPTIONS: readonly { readonly value: SortKey; readonly label: string }[] = [
  { value: 'date-desc', label: '日期（新→旧）' },
  { value: 'date-asc', label: '日期（旧→新）' },
  { value: 'urgency', label: '紧迫度' },
  { value: 'overdue-desc', label: '逾期天数' },
  { value: 'title-asc', label: '名称' },
  { value: 'updated-desc', label: '最近修改' },
];

const MONTHS = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0'));

export interface FilterBarProps {
  readonly query: RecordQuery;
  readonly onChange: (next: RecordQuery) => void;
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  readonly units: readonly string[];
  readonly years: readonly string[];
  /** Hide status/group controls where they do not apply (e.g. the honours view). */
  readonly showWorkFilters?: boolean;
  /**
   * Hide the category control.
   *
   * Separate from `showWorkFilters` because the honours view needs exactly this and nothing else:
   * `matchesAssociations` rejects every non-work record when a category is selected, so on 荣誉 the
   * control could only ever empty the list (audit H-1). A filter that cannot return a result is
   * worse than a missing one.
   */
  readonly showCategoryFilter?: boolean;
  /** What the counterpart column is called here: 对接单位 for work, 授予单位 for honours. */
  readonly unitLabel?: string;
  readonly resultCount: number;
  readonly undatedCount: number;
}

export function FilterBar({
  query,
  onChange,
  categories,
  groups,
  units,
  years,
  showWorkFilters = true,
  showCategoryFilter = true,
  unitLabel = '对接单位',
  resultCount,
  undatedCount,
}: FilterBarProps): ReactNode {
  const searchId = useId();
  const moreId = useId();
  const set = <K extends keyof RecordQuery>(key: K, value: RecordQuery[K]): void => {
    onChange({ ...query, [key]: value });
  };

  const chips = describeActiveFilters(query, categories, groups);

  /*
   * Secondary filters start collapsed, and open by themselves when one of them is in use.
   *
   * Eight always-expanded controls cost ~190 px of vertical space above every list (audit W-4) to
   * present 年份, 月份 and 对接单位 at the same prominence as search — three controls that are reached
   * far less often than the two above them. Collapsing them is only safe if an active one cannot
   * hide: `hasSecondary` forces the panel open, so a filter can never be in force while invisible.
   */
  const [moreOpen, setMoreOpen] = useState(false);
  const showMore = moreOpen || hasSecondaryFilter(query);

  return (
    <div className={`${styles.bar} filter-bar`}>
      <div className={styles.row}>
        <div className={styles.searchWrap}>
          <label className="visually-hidden" htmlFor={searchId}>
            搜索记录
          </label>
          <Search aria-hidden="true" size={16} className={styles.searchIcon} />
          <input
            id={searchId}
            className={styles.search}
            type="search"
            placeholder="搜索事项、单位、对接人、备注、文号…"
            value={query.search}
            onChange={(event) => {
              set('search', event.target.value);
            }}
          />
        </div>

        {showWorkFilters ? (
          <Select
            label="状态"
            value={query.statusBucket}
            onChange={(value) => {
              set('statusBucket', value as StatusBucket);
            }}
            options={STATUS_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        ) : null}

        <Select
          label="排序"
          value={query.sort}
          onChange={(value) => {
            set('sort', value as SortKey);
          }}
          options={SORT_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
        />

        <button
          type="button"
          className={styles.more}
          aria-expanded={showMore}
          aria-controls={moreId}
          onClick={() => {
            setMoreOpen((value) => !value);
          }}
        >
          <SlidersHorizontal aria-hidden="true" size={14} />
          <span>更多筛选</span>
          <ChevronDown
            aria-hidden="true"
            size={14}
            className={showMore ? styles.moreOpen : undefined}
          />
        </button>
      </div>

      <div className={styles.secondary} id={moreId} hidden={!showMore}>
        {showCategoryFilter ? (
          <Select
            label="业务分类"
            value={query.categoryId ?? ''}
            onChange={(value) => {
              set('categoryId', value === '' ? null : value);
            }}
            options={[
              { value: '', label: '全部分类' },
              ...categories.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        ) : null}

        {showWorkFilters ? (
          <Select
            label="归属分组"
            value={query.groupId ?? ''}
            onChange={(value) => {
              set('groupId', value === '' ? null : value);
            }}
            options={[
              { value: '', label: '全部分组' },
              ...groups.map((g) => ({ value: g.id, label: g.name })),
            ]}
          />
        ) : null}

        <Select
          label={unitLabel}
          value={query.unit ?? ''}
          onChange={(value) => {
            set('unit', value === '' ? null : value);
          }}
          options={[
            { value: '', label: '全部单位' },
            ...units.map((u) => ({ value: u, label: u })),
          ]}
        />

        <Select
          label="年份"
          value={query.year ?? ''}
          onChange={(value) => {
            set('year', value === '' ? null : value);
          }}
          options={[
            { value: '', label: '全部年份' },
            ...years.map((y) => ({ value: y, label: `${y}年` })),
          ]}
        />

        <Select
          label="月份"
          value={query.month ?? ''}
          onChange={(value) => {
            set('month', value === '' ? null : value);
          }}
          options={[
            { value: '', label: '全部月份' },
            ...MONTHS.map((m) => ({ value: m, label: `${Number(m)}月` })),
          ]}
        />
      </div>

      <div className={styles.status}>
        <p className={styles.count} role="status">
          共 {resultCount} 条
          {undatedCount > 0 ? `　·　另有 ${undatedCount} 条为文字日期，不参与年/月筛选` : ''}
        </p>
        {chips.length > 0 ? (
          <ul className={styles.chips} aria-label="已启用的筛选">
            {chips.map((chip) => (
              <li key={chip.key}>
                <button
                  type="button"
                  className={styles.chip}
                  onClick={() => {
                    onChange({ ...query, [chip.key]: EMPTY_QUERY[chip.key] });
                  }}
                >
                  <span>
                    {chip.label}：{chip.value}
                  </span>
                  <X aria-hidden="true" size={13} />
                  <span className="visually-hidden">移除此筛选</span>
                </button>
              </li>
            ))}
            <li>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onChange({ ...EMPTY_QUERY, kind: query.kind, sort: query.sort });
                }}
              >
                清除全部筛选
              </Button>
            </li>
          </ul>
        ) : null}
      </div>
    </div>
  );
}

/** Is any collapsible filter in force? Extracted so the component stays inside its complexity budget. */
function hasSecondaryFilter(query: RecordQuery): boolean {
  return (
    query.categoryId !== null ||
    query.groupId !== null ||
    query.unit !== null ||
    query.year !== null ||
    query.month !== null
  );
}

function Select({
  label,
  value,
  onChange,
  options,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly { readonly value: string; readonly label: string }[];
}): ReactNode {
  const id = useId();
  return (
    <div className={styles.selectWrap}>
      <label className={styles.selectLabel} htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className={styles.select}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

interface Chip {
  readonly key: keyof RecordQuery;
  readonly label: string;
  readonly value: string;
}

function describeActiveFilters(
  query: RecordQuery,
  categories: readonly BusinessCategory[],
  groups: readonly WorkGroup[],
): Chip[] {
  const chips: Chip[] = [];
  if (query.search.trim() !== '') chips.push({ key: 'search', label: '搜索', value: query.search });
  if (query.statusBucket !== 'all') {
    const match = STATUS_OPTIONS.find((o) => o.value === query.statusBucket);
    chips.push({ key: 'statusBucket', label: '状态', value: match?.label ?? query.statusBucket });
  }
  if (query.categoryId !== null) {
    const name = categories.find((c) => c.id === query.categoryId)?.name ?? '（已删除）';
    chips.push({ key: 'categoryId', label: '分类', value: name });
  }
  if (query.groupId !== null) {
    const name = groups.find((g) => g.id === query.groupId)?.name ?? '（已删除）';
    chips.push({ key: 'groupId', label: '分组', value: name });
  }
  if (query.unit !== null) chips.push({ key: 'unit', label: '单位', value: query.unit });
  if (query.honorLevel !== null) {
    chips.push({ key: 'honorLevel', label: '级别', value: query.honorLevel });
  }
  if (query.year !== null) chips.push({ key: 'year', label: '年份', value: `${query.year}年` });
  if (query.month !== null) {
    chips.push({ key: 'month', label: '月份', value: `${Number(query.month)}月` });
  }
  if (query.onDay !== null) chips.push({ key: 'onDay', label: '日期', value: query.onDay });
  return chips;
}
