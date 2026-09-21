import { describeIssues } from '@/domain/validation';
import { backupEnvelopeSchema } from '../backup/envelope';
import { checkCompatibility, migrateEnvelope } from '../backup/compatibility';
import type { BackupEnvelope } from '../backup/envelope';

/**
 * Source detection: what kind of file is this, and may this build read it?
 *
 * Split out of `plan.ts` so the plan module stays about *what an import will do* while this one
 * answers *what the file is*. The order of operations here is the load-bearing part, and it is the
 * order Phase 1.1 established: compatibility first, migration second, schema validation third.
 * Judging compatibility last would report a file from a future build as "内容未通过校验" and send the
 * user looking for corruption that does not exist.
 */

export type SourceFormat =
  /** A CivicWorkDesk envelope. */
  | 'civic-envelope'
  /** Legacy `{version, exportTime, works}`. */
  | 'legacy-versioned'
  /** Legacy `{works, honors}` with a separate honours array. */
  | 'legacy-split'
  /** A bare array of legacy records. */
  | 'legacy-array';

export class ImportParseError extends Error {
  override readonly name = 'ImportParseError';
  readonly details: readonly string[];
  constructor(message: string, details: readonly string[] = []) {
    super(message);
    this.details = details;
  }
}

export interface DetectedSource {
  readonly format: SourceFormat;
  readonly rows: readonly unknown[];
  readonly envelope: BackupEnvelope | null;
}

/** Identify the shape of a parsed JSON document. Throws when nothing recognisable is found. */
export function detectSource(parsed: unknown): DetectedSource {
  if (Array.isArray(parsed)) {
    return { format: 'legacy-array', rows: parsed, envelope: null };
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new ImportParseError('文件内容不是备份数据（既不是数组，也不是对象）。');
  }
  const obj = parsed as Record<string, unknown>;

  if (obj['application'] === 'civic-work-desk') {
    /*
     * Compatibility is judged BEFORE the payload is validated. An envelope from a newer build will
     * usually also fail the current schema, and reporting that as "内容未通过校验" would send the
     * user looking for corruption that does not exist.
     */
    const verdict = checkCompatibility({
      backupFormatVersion: obj['backupFormatVersion'],
      schemaVersion: obj['schemaVersion'],
    });
    if (!verdict.compatible) {
      throw new ImportParseError(
        verdict.message ?? '该备份版本与当前应用不兼容。',
        verdict.detail === undefined ? [] : [verdict.detail],
      );
    }

    const migrated = migrateEnvelope(obj);
    const result = backupEnvelopeSchema.safeParse(migrated);
    if (!result.success) {
      throw new ImportParseError(
        '这是 CivicWorkDesk 备份文件，但内容未通过校验，已拒绝导入。',
        describeIssues(result.error, 6),
      );
    }
    /*
     * Shape is not semantics.
     *
     * A v3 envelope can satisfy the schema, carry a matching whole-envelope digest and consistent
     * counts while still making contradictory claims about itself — `completeness: 'complete'`
     * alongside a non-empty `omittedInvalidRowIds`, or `'incomplete'` with no omission evidence at
     * all. The digest guarantees the bytes were not altered; it says nothing about whether the
     * statements inside them agree. A restore must not resolve that contradiction by picking whichever
     * field it happens to read.
     */
    const contradiction = completenessContradiction(result.data);
    if (contradiction !== null) {
      throw new ImportParseError('该备份的完整性声明自相矛盾，已拒绝导入。', [contradiction]);
    }

    return { format: 'civic-envelope', rows: result.data.payload.records, envelope: result.data };
  }

  const works = obj['works'];
  const honors = obj['honors'];
  if (Array.isArray(works)) {
    const rows: unknown[] = Array.isArray(honors)
      ? [...(works as unknown[]), ...(honors as unknown[]).map(attachHonorCategory)]
      : (works as unknown[]);
    return {
      format: Array.isArray(honors) ? 'legacy-split' : 'legacy-versioned',
      rows,
      envelope: null,
    };
  }
  throw new ImportParseError('无法识别的备份格式：未找到 works 数组或 CivicWorkDesk 信封。');
}

/**
 * Mark a row from a legacy standalone `honors` array as an honour.
 * The legacy code did `Object.assign({category:'荣誉'}, h)`, which let the row's own `category`
 * win; the explicit spread order here makes the honour classification authoritative.
 */
function attachHonorCategory(row: unknown): unknown {
  if (row === null || typeof row !== 'object') return row;
  return { ...(row as Record<string, unknown>), category: '荣誉' };
}

/**
 * The way a v3 envelope's completeness metadata contradicts itself, or null when it is coherent.
 *
 * The rule is an equivalence, checked in both directions:
 *
 *   `completeness === 'complete'` **iff** `omittedInvalidRowIds` is empty.
 *
 * `unknown-legacy` is exempt: it describes a v1 archive, whose format had no omission list at all, so
 * an empty list there is the absence of evidence rather than a claim of completeness.
 */
function completenessContradiction(envelope: BackupEnvelope): string | null {
  const omitted = envelope.omittedInvalidRowIds.length;
  if (envelope.completeness === 'complete' && omitted > 0) {
    return (
      `文件声明 completeness="complete"，但同时列出了 ${String(omitted)} 行被省略的数据` +
      '（omittedInvalidRowIds 非空）。两者不可能同时为真。'
    );
  }
  if (envelope.completeness === 'incomplete' && omitted === 0) {
    return (
      '文件声明 completeness="incomplete"，但没有给出任何被省略的数据行' +
      '（omittedInvalidRowIds 为空）。“不完整”必须有可核对的省略清单。'
    );
  }
  return null;
}
