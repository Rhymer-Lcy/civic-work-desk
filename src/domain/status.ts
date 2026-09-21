/**
 * Canonical work status.
 *
 * The legacy prototype had no status enum. It stored a free-text label in `done` and derived
 * meaning with prefix matching, which produced two concrete defects:
 *
 *   1. `未完成` ("not completed") was classified by `isOther()` alongside `取消`/`推迟`
 *      (cancelled/deferred), so genuinely outstanding work sat in a tab labelled
 *      "cancelled/postponed" and was excluded from the pending count.
 *   2. `statusOf()` tested `longterm` **before** completion, so a finished long-term item
 *      rendered as "长期推进" forever and never counted as done.
 *
 * Here the canonical state and the user-facing label are separate fields. `status` drives every
 * calculation; `statusLabel` preserves whatever wording the record arrived with so nothing is
 * lost, and `longTerm` is an orthogonal flag that no longer overrides completion.
 */

export const WORK_STATUSES = ['todo', 'in-progress', 'completed', 'cancelled', 'deferred'] as const;

export type WorkStatus = (typeof WORK_STATUSES)[number];

export function isWorkStatus(value: unknown): value is WorkStatus {
  return typeof value === 'string' && (WORK_STATUSES as readonly string[]).includes(value);
}

/** Statuses that close a record: they can never be overdue and never need follow-up. */
const TERMINAL: ReadonlySet<WorkStatus> = new Set<WorkStatus>(['completed', 'cancelled']);

export function isTerminalStatus(status: WorkStatus): boolean {
  return TERMINAL.has(status);
}

/** Statuses that still represent outstanding work. `deferred` is open: it was put off, not closed. */
export function isOpenStatus(status: WorkStatus): boolean {
  return !TERMINAL.has(status);
}

/** Statuses whose deadline should still raise urgency. Deferred work keeps its deadline. */
export function participatesInUrgency(status: WorkStatus): boolean {
  return status === 'todo' || status === 'in-progress' || status === 'deferred';
}

export const STATUS_LABELS_ZH: Readonly<Record<WorkStatus, string>> = Object.freeze({
  todo: '待办',
  'in-progress': '进行中',
  completed: '已完成',
  cancelled: '已取消',
  deferred: '已推迟',
});

/**
 * Legacy free-text label -> canonical status.
 *
 * Keys are exact, trimmed legacy values seen in the prototype's option list and data.
 * Anything unrecognised is NOT guessed: `mapLegacyStatus` returns `null` so the import layer
 * can raise a warning and keep the original wording.
 */
const LEGACY_STATUS_MAP: Readonly<Record<string, WorkStatus>> = Object.freeze({
  完成: 'completed',
  已完成: 'completed',
  完成了: 'completed',
  进行中: 'in-progress',
  在办: 'in-progress',
  办理中: 'in-progress',
  未完成: 'todo',
  待办: 'todo',
  未开始: 'todo',
  取消: 'cancelled',
  已取消: 'cancelled',
  作废: 'cancelled',
  推迟: 'deferred',
  已推迟: 'deferred',
  延期: 'deferred',
});

export interface LegacyStatusMapping {
  readonly status: WorkStatus;
  /** True when the canonical status was inferred rather than matched exactly. */
  readonly inferred: boolean;
}

/**
 * Resolve a legacy `done` value.
 *
 * An empty value means "nothing recorded", which is `todo` — that is not an inference, it is
 * the documented legacy default. A non-empty value that matches no key returns `null`.
 */
export function mapLegacyStatus(raw: unknown): LegacyStatusMapping | null {
  if (raw === null || raw === undefined) return { status: 'todo', inferred: false };
  if (typeof raw !== 'string') return null;

  const value = raw.trim();
  if (value === '') return { status: 'todo', inferred: false };

  const exact = LEGACY_STATUS_MAP[value];
  if (exact) return { status: exact, inferred: false };

  // The legacy UI let users type arbitrary option values, so a suffixed or annotated label
  // such as `完成（已上报）` is common. Prefix matching is applied only after an exact miss,
  // and the match is reported as inferred so the import preview can show it.
  for (const [key, status] of Object.entries(LEGACY_STATUS_MAP)) {
    if (value.startsWith(key)) return { status, inferred: true };
  }
  return null;
}
