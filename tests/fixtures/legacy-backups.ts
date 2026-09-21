/**
 * Sanitised legacy fixtures.
 *
 * These reproduce the *structural* edge cases found in the real prototype data. They contain no
 * real person, no real phone number, no real organisation and no real work description. Names are
 * placeholders (甲/乙/丙), organisations are generic (示范单位), and the phone numbers use the
 * 138-0013-xxxx block reserved for documentation examples in Chinese telecoms material.
 *
 * Every entry is annotated with the legacy defect it stands for, and each is asserted in
 * `tests/unit/legacy-normalisation.test.ts`. See docs/migration.md for the rule each one exercises.
 */

/** Record shape as written by the prototype's own `normalizeRecord()`. */
export interface LegacyRecordShape {
  id?: string;
  category?: string;
  date?: string;
  title?: string;
  name?: string;
  requirement?: string;
  deadlineType?: string;
  deadline?: string;
  dueType?: string;
  due?: string;
  done?: string;
  doneTime?: string;
  unit?: string;
  contact?: string;
  phone?: string | number;
  remark?: string;
  longterm?: boolean;
  progress?: unknown[];
  hType?: string;
  hLevel?: string;
  hNo?: string;
  hRole?: string;
  hEvidence?: string;
  hRelated?: string;
  fixedGroup?: string;
  biz?: string;
  createdAt?: number;
  [key: string]: unknown;
}

function base(overrides: LegacyRecordShape): LegacyRecordShape {
  return {
    category: '',
    date: '',
    title: '',
    requirement: '',
    deadlineType: 'none',
    deadline: '',
    dueType: '',
    due: '',
    done: '',
    doneTime: '',
    unit: '',
    contact: '',
    phone: '',
    remark: '',
    longterm: false,
    progress: [],
    hType: '',
    hLevel: '',
    hNo: '',
    hRole: '',
    hEvidence: '',
    hRelated: '',
    fixedGroup: '',
    biz: '',
    ...overrides,
  };
}

export const LEGACY_EDGE_CASES: readonly LegacyRecordShape[] = [
  // 1. The ordinary case: a clean ISO date and a recognised completion label.
  base({
    id: 'fix_001',
    date: '2026-01-04',
    title: '填报示范单位季度进展情况',
    requirement: '填报表格',
    done: '完成',
    doneTime: '2026-01-09',
    unit: '示范单位甲',
    contact: '联系人甲',
    phone: '13800130001',
    biz: '考核·填报',
  }),

  // 2. Month-only date. `new Date('1月')` was NaN, so the record vanished from every report.
  base({
    id: 'fix_002',
    date: '1月',
    title: '年度组织生活会准备',
    done: '完成',
    doneTime: '2026-02-27',
    biz: '党建·纪检·法治',
  }),

  // 3. A malformed date typo (day/day instead of month/day). Must be preserved, never guessed.
  base({
    id: 'fix_003',
    date: '4日14日',
    title: '第三次全体会议',
    done: '完成',
    biz: '会议·活动',
  }),

  // 4. Free-text reporting deadline with `deadlineType: 'text'` — intended free text, not a defect.
  base({
    id: 'fix_004',
    date: '2026-01-20',
    title: '关于示范事项的建议办理',
    requirement: '会办件',
    deadlineType: 'text',
    deadline: '待定（4月前）',
    done: '完成',
    doneTime: '5月13日上传',
    unit: '示范单位乙',
    biz: '对非合作',
  }),

  // 5. `deadlineType: 'date'` but the value is free text — the discriminator disagrees with the
  //    value, which the legacy code trusted blindly.
  base({
    id: 'fix_005',
    date: '2026-03-03',
    title: '征求各方意见清单',
    deadlineType: 'date',
    deadline: '3月5日12时前',
    done: '完成',
    biz: '会议·活动',
  }),

  // 6. `dueType` empty while `due` is populated — the exact inconsistency in the real data.
  base({
    id: 'fix_006',
    date: '2026-02-13',
    title: '重点工作责任分解',
    deadlineType: 'date',
    deadline: '2026-03-31',
    dueType: '',
    due: '2026-03-20',
    done: '',
    unit: '示范单位丙',
    contact: '联系人乙',
    phone: '13800130002',
    biz: '文稿·材料',
  }),

  // 7. Spreadsheet-derived landline with a trailing `.0`. Must be reported, not silently trimmed.
  base({
    id: 'fix_007',
    date: '2026-01-06',
    title: '报送年度法治建设工作要点',
    requirement: '上报反馈意见',
    done: '完成',
    doneTime: '2026-01-09',
    unit: '示范单位丁',
    contact: '联系人丙',
    phone: '82393933.0',
    biz: '文稿·材料',
  }),

  // 8. Two numbers in one field, separated by a newline.
  base({
    id: 'fix_008',
    date: '2026-03-31',
    title: '再次征求示范规划意见',
    deadlineType: 'text',
    deadline: '4月2日下班前',
    done: '完成',
    unit: '示范单位戊',
    contact: '联系人丁\n联系人戊',
    phone: '656430\n673679',
    remark: '无意见',
    biz: '文稿·材料',
  }),

  // 9. A phone that arrived as a JSON number: leading zeroes are already gone upstream.
  base({
    id: 'fix_009',
    date: '2026-04-01',
    title: '示范事项联络登记',
    phone: 13800130003,
    biz: '财务·后勤·综合',
  }),

  // 10. `未完成` — legacy `isOther()` filed this with 取消/推迟; it is genuinely outstanding work.
  base({
    id: 'fix_010',
    date: '2026-05-06',
    title: '待办的示范事项',
    done: '未完成',
    deadlineType: 'date',
    deadline: '2026-05-20',
    biz: '意见反馈',
  }),

  // 11. A completed long-term item. Legacy `statusOf()` showed it as 长期推进 forever.
  base({
    id: 'fix_011',
    date: '2026-04-15',
    title: '长期推进的示范专项',
    deadlineType: 'text',
    deadline: '长期推进',
    done: '完成',
    doneTime: '2026-08-01',
    longterm: true,
    fixedGroup: '长期推进',
    biz: '文稿·材料',
  }),

  // 12. An unrecognised completion wording. Must be kept verbatim and reported, not dropped.
  base({
    id: 'fix_012',
    date: '2026-06-02',
    title: '状态措辞异常的示范事项',
    done: '基本完成（待复核）',
    biz: '会议·活动',
  }),

  // 13. Progress entries in the legacy array-on-the-record shape, including an empty one.
  base({
    id: 'fix_013',
    date: '2026-07-01',
    title: '带进展记录的示范事项',
    done: '进行中',
    progress: [
      { date: '2026-07-02', content: '已联系相关单位收集材料' },
      { date: '', content: '初稿完成' },
      { date: '2026-07-10', content: '' },
      '纯文本形式的进展条目',
    ],
    biz: '文稿·材料',
  }),

  // 14. An honour in the current shape.
  base({
    id: 'fix_014',
    category: '荣誉',
    date: '2026-03-15',
    title: '示范工作感谢信',
    done: '完成',
    doneTime: '2026-03-15',
    unit: '示范上级机关',
    hType: '感谢信',
    hLevel: '省级',
    hNo: '示范函〔2026〕1号',
    hRole: '主要承办人',
    hEvidence: '原件存档案柜示范号盒',
    remark: '示范备注',
  }),

  // 15. An honour in the *oldest* shape (`name`/`type`/`level`/`from`/`no`/`role`/`evidence`).
  {
    id: 'fix_015',
    name: '示范先进集体',
    date: '2026-06-20',
    type: '表彰（先进集体/个人）',
    level: '市级',
    from: '示范人民政府',
    no: '示范发〔2026〕2号',
    role: '集体荣誉',
    evidence: '奖牌存展示柜',
  },

  // 16. An impossible calendar date. Never shifted to 3 March.
  base({
    id: 'fix_016',
    date: '2026-02-30',
    title: '日期不存在的示范事项',
    biz: '意见反馈',
  }),

  // 17. A category name that is not one of the built-ins.
  base({
    id: 'fix_017',
    date: '2026-08-05',
    title: '分类名称未知的示范事项',
    biz: '某个已废弃的分类',
  }),

  // 18. An unrecognised extra field. Must land in `legacyResidue`, not be discarded.
  base({
    id: 'fix_018',
    date: '2026-08-06',
    title: '带有额外字段的示范事项',
    customLegacyField: '这个值在新模型中没有对应字段',
    biz: '文稿·材料',
  }),

  // 19. No title at all: the only condition under which a row is rejected.
  base({ id: 'fix_019', date: '2026-08-07', title: '   ' }),

  // 20. A date in a non-canonical but unambiguous form.
  base({
    id: 'fix_020',
    date: '2026/9/7',
    title: '斜杠日期格式的示范事项',
    biz: '培训·学习',
  }),
];

/** Legacy `{version, exportTime, works}` envelope. */
export function legacyVersionedBackup(): unknown {
  return {
    version: 3,
    exportTime: '2026-09-01T00:00:00.000Z',
    works: LEGACY_EDGE_CASES,
  };
}

/** Legacy `{works, honors}` split shape, where honours lived in their own array. */
export function legacySplitBackup(): unknown {
  return {
    works: LEGACY_EDGE_CASES.filter((record) => record.category !== '荣誉' && !record.name),
    honors: [
      {
        id: 'fix_split_honor',
        name: '拆分数组中的示范荣誉',
        date: '2026-05-01',
        type: '表扬信',
        level: '单位内部',
        from: '示范单位己',
        role: '参与人',
      },
    ],
  };
}

/** The oldest shape: a bare array with no envelope at all. */
export function legacyArrayBackup(): unknown {
  return LEGACY_EDGE_CASES.slice(0, 5);
}

/** Two rows sharing an id inside one file — the legacy importer inserted both. */
export function duplicateIdBackup(): unknown {
  return {
    works: [
      base({ id: 'dup_1', date: '2026-01-01', title: '第一条重复 ID 记录' }),
      base({ id: 'dup_1', date: '2026-01-02', title: '第二条重复 ID 记录' }),
    ],
  };
}
