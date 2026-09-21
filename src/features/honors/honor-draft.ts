import { ABSENT_DATE } from '@/domain/dates';
import type { DateValue } from '@/domain/dates';
import type { HonorRecord } from '@/domain/types';

/** The editable shape of an honour record. Kept out of the component file; see work-draft.ts. */
export interface HonorDraft {
  title: string;
  awardedOn: DateValue;
  honorType: string;
  level: string;
  issuingOrg: string;
  documentNo: string;
  personalRole: string;
  evidenceLocation: string;
  relatedWorkId: string | null;
  remark: string;
}

export function emptyHonorDraft(): HonorDraft {
  return {
    title: '',
    awardedOn: ABSENT_DATE,
    honorType: '',
    level: '',
    issuingOrg: '',
    documentNo: '',
    personalRole: '',
    evidenceLocation: '',
    relatedWorkId: null,
    remark: '',
  };
}

export function draftFromHonor(record: HonorRecord): HonorDraft {
  return {
    title: record.title,
    awardedOn: record.awardedOn,
    honorType: record.honorType,
    level: record.level,
    issuingOrg: record.issuingOrg,
    documentNo: record.documentNo,
    personalRole: record.personalRole,
    evidenceLocation: record.evidenceLocation,
    relatedWorkId: record.relatedWorkId,
    remark: record.remark,
  };
}
