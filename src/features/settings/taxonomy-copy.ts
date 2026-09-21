/**
 * Wording for taxonomy deletions, kept out of the component file so it can be asserted directly.
 *
 * These strings are the user-facing half of a data invariant, not decoration: a taxonomy row is
 * referenced by every record that names it, including records sitting in the Trash, because those
 * rows still exist and are still carried in backups.
 */

/**
 * What deleting a group will actually do, counted over every record the deletion touches.
 *
 * `deleteGroup` detaches its members whether or not they are in the Trash, so a confirmation built
 * from the live count alone would understate the effect — and, for a group used exclusively by
 * trashed records, would not appear at all.
 */
export function groupDeleteConfirm(live: number, trashed: number): string | undefined {
  if (live + trashed === 0) return undefined;
  const scope =
    trashed === 0
      ? `${String(live)} 条记录`
      : live === 0
        ? `${String(trashed)} 条回收站中的记录`
        : `${String(live)} 条记录（另有回收站中的 ${String(trashed)} 条）`;
  return `该分组下有 ${scope}，删除后它们会变为「未分组」，记录本身不会被删除。`;
}

/**
 * Why a category cannot be deleted, or `undefined` when it can.
 *
 * `deleteCategoryIfUnused` counts trashed records as users and refuses, so offering the action on
 * the strength of a live count alone would produce a refusal the user cannot explain.
 */
export function categoryDeleteHint(
  builtIn: boolean,
  live: number,
  trashed: number,
): string | undefined {
  if (builtIn) return '内置分类不可删除，可停用。';
  if (live > 0) return '仍有记录使用该分类，不可删除，可停用。';
  if (trashed > 0) {
    return `回收站中还有 ${String(trashed)} 条记录使用该分类，不可删除，可停用。`;
  }
  return undefined;
}
