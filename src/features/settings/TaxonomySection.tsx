import { useState } from 'react';
import type { ReactNode } from 'react';
import { ArrowDown, ArrowUp, Check, Trash2 } from 'lucide-react';
import { useRefresh } from '@/app/store/data-store';
import {
  addCategory,
  addGroup,
  deleteCategoryIfUnused,
  deleteGroup,
  moveCategory,
  renameCategory,
  renameGroup,
  setCategoryArchived,
} from '@/db/repositories/taxonomy';
import { isWorkRecord } from '@/domain/types';
import type { AnyRecord, BusinessCategory, WorkGroup } from '@/domain/types';
import { Button, Card, ConfirmDialog, useToast } from '@/components/common';
import { categoryDeleteHint, groupDeleteConfirm } from './taxonomy-copy';
import styles from './SettingsPage.module.css';

/**
 * Categories and groups.
 *
 * Renaming is a one-row write because records reference ids. In the legacy version the record
 * stored the category *name*, so `renameBiz()` detached every record using it, and it did so
 * through a `window.prompt()` with no validation — an empty or duplicate name was accepted.
 *
 * Deletion states its consequences: a category in use cannot be deleted (archive it instead), and
 * deleting a group reports how many records it detached.
 */

export interface TaxonomySectionProps {
  readonly categories: readonly BusinessCategory[];
  readonly groups: readonly WorkGroup[];
  readonly records: readonly AnyRecord[];
}

export function TaxonomySection({ categories, groups, records }: TaxonomySectionProps): ReactNode {
  const refresh = useRefresh();
  const toast = useToast();

  /*
   * Two counts per taxonomy row, deliberately.
   *
   * `usage` is what the user sees listed — live records only, because a record in the Trash is not
   * something they are currently filtering or reporting on. But the database counts a trashed record
   * as a user of its category and group: the row still exists, it is carried in backups, and
   * `deleteCategoryIfUnused` refuses while it does. Counting only live records here would make the UI
   * offer a deletion the database then refuses without saying why, and — worse — let a group deletion
   * detach trashed records with no confirmation at all.
   */
  const categoryUsage = new Map<string, number>();
  const groupUsage = new Map<string, number>();
  const trashedCategoryUsage = new Map<string, number>();
  const trashedGroupUsage = new Map<string, number>();
  for (const record of records) {
    if (!isWorkRecord(record)) continue;
    const categories = record.deletedAt === null ? categoryUsage : trashedCategoryUsage;
    const groups = record.deletedAt === null ? groupUsage : trashedGroupUsage;
    if (record.categoryId) {
      categories.set(record.categoryId, (categories.get(record.categoryId) ?? 0) + 1);
    }
    if (record.groupId) {
      groups.set(record.groupId, (groups.get(record.groupId) ?? 0) + 1);
    }
  }
  const trashedCategories = (id: string): number => trashedCategoryUsage.get(id) ?? 0;
  const trashedGroups = (id: string): number => trashedGroupUsage.get(id) ?? 0;

  const run = async (operation: () => Promise<string>): Promise<void> => {
    try {
      const message = await operation();
      await refresh();
      toast.show(message, 'success');
    } catch (cause) {
      toast.show(cause instanceof Error ? cause.message : String(cause), 'error');
    }
  };

  return (
    <>
      <Card
        title="业务分类"
        description="用于给工作记录打标签、筛选与统计。记录按分类 ID 关联，改名不会影响已有记录。"
      >
        <ul className={styles.list}>
          {categories.map((category, index) => (
            <TaxonomyRow
              key={`${category.id}:${category.name}`}
              name={category.name}
              usage={categoryUsage.get(category.id) ?? 0}
              builtIn={category.builtIn}
              archived={category.archived}
              canMoveUp={index > 0}
              canMoveDown={index < categories.length - 1}
              onRename={(next) =>
                run(async () => {
                  await renameCategory(category.id, next);
                  return `分类已改名为「${next}」。`;
                })
              }
              onMove={(direction) =>
                run(async () => {
                  await moveCategory(category.id, direction);
                  return '已调整顺序。';
                })
              }
              onArchive={(archived) =>
                run(async () => {
                  await setCategoryArchived(category.id, archived);
                  return archived ? '已停用该分类（历史记录不变）。' : '已重新启用该分类。';
                })
              }
              onDelete={
                category.builtIn ||
                (categoryUsage.get(category.id) ?? 0) > 0 ||
                trashedCategories(category.id) > 0
                  ? undefined
                  : () =>
                      run(async () => {
                        const done = await deleteCategoryIfUnused(category.id);
                        return done ? '已删除该分类。' : '该分类仍在使用中，未删除。';
                      })
              }
              deleteHint={categoryDeleteHint(
                category.builtIn,
                categoryUsage.get(category.id) ?? 0,
                trashedCategories(category.id),
              )}
            />
          ))}
        </ul>
        <AddRow
          label="新的业务分类名称"
          buttonLabel="添加分类"
          onAdd={(name) =>
            run(async () => {
              await addCategory(name);
              return `已添加分类「${name}」。`;
            })
          }
        />
      </Card>

      <Card title="归属分组" description="固定 / 长期 / 分管等常驻分组，显示在概览页侧栏。">
        <ul className={styles.list}>
          {groups.map((group) => (
            <TaxonomyRow
              key={`${group.id}:${group.name}`}
              name={group.name}
              usage={groupUsage.get(group.id) ?? 0}
              builtIn={group.builtIn}
              archived={group.archived}
              canMoveUp={false}
              canMoveDown={false}
              onRename={(next) =>
                run(async () => {
                  await renameGroup(group.id, next);
                  return `分组已改名为「${next}」。`;
                })
              }
              onDelete={
                group.builtIn
                  ? undefined
                  : () =>
                      run(async () => {
                        const detached = await deleteGroup(group.id);
                        return detached > 0
                          ? `已删除分组，${detached} 条记录已改为「未分组」。`
                          : '已删除分组。';
                      })
              }
              deleteHint={group.builtIn ? '内置分组不可删除。' : undefined}
              deleteConfirm={groupDeleteConfirm(
                groupUsage.get(group.id) ?? 0,
                trashedGroups(group.id),
              )}
            />
          ))}
        </ul>
        <AddRow
          label="新的分组名称"
          buttonLabel="添加分组"
          onAdd={(name) =>
            run(async () => {
              await addGroup(name);
              return `已添加分组「${name}」。`;
            })
          }
        />
      </Card>
    </>
  );
}

interface TaxonomyRowProps {
  readonly name: string;
  readonly usage: number;
  readonly builtIn: boolean;
  readonly archived: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly onRename: (next: string) => Promise<void>;
  readonly onMove?: ((direction: -1 | 1) => Promise<void>) | undefined;
  readonly onArchive?: ((archived: boolean) => Promise<void>) | undefined;
  readonly onDelete?: (() => Promise<void>) | undefined;
  readonly deleteHint?: string | undefined;
  readonly deleteConfirm?: string | undefined;
}

function TaxonomyRow(props: TaxonomyRowProps): ReactNode {
  // Seeded from the prop once. The parent gives each row a key that includes the committed name,
  // so a successful rename remounts the row and the field reflects the new value without an
  // effect that would re-render every row on any parent update.
  const [draft, setDraft] = useState(props.name);
  const [confirming, setConfirming] = useState(false);

  const dirty = draft.trim() !== props.name && draft.trim() !== '';

  return (
    <li className={styles.item}>
      <label className="visually-hidden" htmlFor={`taxonomy-${props.name}`}>
        名称：{props.name}
      </label>
      <input
        id={`taxonomy-${props.name}`}
        className={styles.itemName}
        type="text"
        value={draft}
        maxLength={60}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
      />
      <span className={styles.itemMeta}>
        {props.usage} 条{props.archived ? '　已停用' : ''}
      </span>
      <div className={styles.itemActions}>
        {dirty ? (
          <Button
            size="sm"
            variant="primary"
            iconOnly
            icon={<Check size={14} />}
            aria-label={`保存「${props.name}」的新名称`}
            onClick={() => void props.onRename(draft.trim())}
          />
        ) : null}
        {props.onMove && props.canMoveUp ? (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<ArrowUp size={14} />}
            aria-label={`将「${props.name}」上移`}
            onClick={() => void props.onMove?.(-1)}
          />
        ) : null}
        {props.onMove && props.canMoveDown ? (
          <Button
            size="sm"
            variant="ghost"
            iconOnly
            icon={<ArrowDown size={14} />}
            aria-label={`将「${props.name}」下移`}
            onClick={() => void props.onMove?.(1)}
          />
        ) : null}
        {props.onArchive ? (
          <Button size="sm" variant="ghost" onClick={() => void props.onArchive?.(!props.archived)}>
            {props.archived ? '启用' : '停用'}
          </Button>
        ) : null}
        {props.onDelete ? (
          <Button
            size="sm"
            variant="danger"
            iconOnly
            icon={<Trash2 size={14} />}
            aria-label={`删除「${props.name}」`}
            onClick={() => {
              setConfirming(true);
            }}
          />
        ) : null}
      </div>
      {props.deleteHint ? <p className={styles.note}>{props.deleteHint}</p> : null}

      <ConfirmDialog
        open={confirming}
        title={`删除「${props.name}」？`}
        body={props.deleteConfirm ?? '删除后不可撤销。'}
        confirmLabel="删除"
        onCancel={() => {
          setConfirming(false);
        }}
        onConfirm={() => {
          setConfirming(false);
          void props.onDelete?.();
        }}
      />
    </li>
  );
}

function AddRow({
  label,
  buttonLabel,
  onAdd,
}: {
  readonly label: string;
  readonly buttonLabel: string;
  readonly onAdd: (name: string) => Promise<void>;
}): ReactNode {
  const [value, setValue] = useState('');
  const id = `add-${buttonLabel}`;
  return (
    <div className={styles.addRow}>
      <label className="visually-hidden" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className={styles.addInput}
        type="text"
        placeholder={label}
        maxLength={60}
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && value.trim() !== '') {
            event.preventDefault();
            void onAdd(value.trim()).then(() => {
              setValue('');
            });
          }
        }}
      />
      <Button
        variant="secondary"
        disabled={value.trim() === ''}
        onClick={() => {
          void onAdd(value.trim()).then(() => {
            setValue('');
          });
        }}
      >
        {buttonLabel}
      </Button>
    </div>
  );
}
