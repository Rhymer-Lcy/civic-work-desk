import type { AppSettings, BusinessCategory, OptionSets, WorkGroup } from './types';

/**
 * Seed data.
 *
 * The category names, group names and option lists are the legacy prototype's defaults,
 * preserved so a migrated archive keeps its vocabulary. The *identifiers* are new and stable:
 * the legacy version stored the category name on each record, so renaming `对非合作` in Settings
 * silently detached every record that used it. Here records reference `id`.
 */

/** Deterministic ids let migration map a legacy name onto the right seeded category. */
export const BUILT_IN_CATEGORY_IDS = {
  africaCooperation: 'cat-africa-cooperation',
  sisterCities: 'cat-sister-cities',
  hostingAndVisits: 'cat-hosting-visits',
  jointHandling: 'cat-joint-handling',
  meetingsAndEvents: 'cat-meetings-events',
  documentsAndDrafting: 'cat-documents-drafting',
  feedback: 'cat-feedback',
  trainingAndStudy: 'cat-training-study',
  appraisalAndFiling: 'cat-appraisal-filing',
  partyAndLegal: 'cat-party-legal',
  unitedFront: 'cat-united-front',
  financeAndLogistics: 'cat-finance-logistics',
} as const;

interface CategorySeed {
  readonly id: string;
  readonly name: string;
}

const CATEGORY_SEEDS: readonly CategorySeed[] = [
  { id: BUILT_IN_CATEGORY_IDS.africaCooperation, name: '对非合作' },
  { id: BUILT_IN_CATEGORY_IDS.sisterCities, name: '友城友协' },
  { id: BUILT_IN_CATEGORY_IDS.hostingAndVisits, name: '接待·出访' },
  { id: BUILT_IN_CATEGORY_IDS.jointHandling, name: '会办件·建议提案' },
  { id: BUILT_IN_CATEGORY_IDS.meetingsAndEvents, name: '会议·活动' },
  { id: BUILT_IN_CATEGORY_IDS.documentsAndDrafting, name: '文稿·材料' },
  { id: BUILT_IN_CATEGORY_IDS.feedback, name: '意见反馈' },
  { id: BUILT_IN_CATEGORY_IDS.trainingAndStudy, name: '培训·学习' },
  { id: BUILT_IN_CATEGORY_IDS.appraisalAndFiling, name: '考核·填报' },
  { id: BUILT_IN_CATEGORY_IDS.partyAndLegal, name: '党建·纪检·法治' },
  { id: BUILT_IN_CATEGORY_IDS.unitedFront, name: '统战·双拥' },
  { id: BUILT_IN_CATEGORY_IDS.financeAndLogistics, name: '财务·后勤·综合' },
];

export function defaultCategories(): BusinessCategory[] {
  return CATEGORY_SEEDS.map((seed, index) => ({
    id: seed.id,
    name: seed.name,
    sortOrder: index,
    builtIn: true,
    archived: false,
  }));
}

export const BUILT_IN_GROUP_IDS = {
  fixed: 'grp-fixed',
  longTerm: 'grp-long-term',
  supervised: 'grp-supervised',
} as const;

export function defaultGroups(): WorkGroup[] {
  return [
    {
      id: BUILT_IN_GROUP_IDS.fixed,
      name: '固定工作',
      sortOrder: 0,
      builtIn: true,
      archived: false,
    },
    {
      id: BUILT_IN_GROUP_IDS.longTerm,
      name: '长期推进',
      sortOrder: 1,
      builtIn: true,
      archived: false,
    },
    {
      id: BUILT_IN_GROUP_IDS.supervised,
      name: '分管工作',
      sortOrder: 2,
      builtIn: true,
      archived: false,
    },
  ];
}

export function defaultOptionSets(): OptionSets {
  return {
    honorType: [
      '感谢信',
      '表扬信',
      '表彰（先进集体/个人）',
      '奖励（嘉奖/记功）',
      '通报表扬',
      '领导批示肯定',
      '考核优秀',
      '其他',
    ],
    honorLevel: ['国家级', '省级', '市级', '县区级', '单位内部', '其他'],
    personalRole: ['主要承办人', '参与人', '组织协调', '集体荣誉'],
  };
}

/**
 * Default product wording.
 *
 * The legacy `<h1>` read `政务工作记录台（离线版）` while its `<title>` and Settings placeholder
 * both read `政务工作记录台`. The shorter form is the more authoritative product name — the
 * parenthetical described a deployment mode that no longer applies, since this build is a
 * proper installable PWA rather than a double-clicked file. Both remain user-editable.
 */
export const DEFAULT_APP_TITLE = '政务工作记录台';
export const DEFAULT_APP_SUBTITLE = '数据保存在本机浏览器，建议定期导出 JSON 备份';

export function defaultSettings(): AppSettings {
  return {
    appTitle: DEFAULT_APP_TITLE,
    appSubtitle: DEFAULT_APP_SUBTITLE,
    options: defaultOptionSets(),
    backupReminderDays: 7,
  };
}

/**
 * Keyword rules that assigned a category to legacy records that had none.
 *
 * Kept verbatim from the prototype so a re-import reproduces the same assignment, but with two
 * changes: the result is a stable category id, and an unmatched title yields `null`
 * ("uncategorised") instead of the legacy behaviour of silently falling back to the *last*
 * category in the list — which put unrelated work into `财务·后勤·综合`.
 */
const CATEGORY_RULES: readonly (readonly [string, readonly string[]])[] = [
  [
    BUILT_IN_CATEGORY_IDS.africaCooperation,
    [
      '非洲',
      '中非',
      '对非',
      '非盟',
      '加蓬',
      '利伯维尔',
      '布法罗',
      '埃塞',
      '乌干达',
      '赞比亚',
      '坦桑',
      '非合作',
      '非经贸',
      '零关税',
      '浙非',
    ],
  ],
  [
    BUILT_IN_CATEGORY_IDS.sisterCities,
    ['友城', '友好城市', '克拉斯诺达尔', '结好', '友协', '友好省州'],
  ],
  [
    BUILT_IN_CATEGORY_IDS.hostingAndVisits,
    [
      '接待',
      '来访',
      '出访',
      '访问',
      '考察',
      '团组',
      '外宾',
      '会见',
      '拜访',
      '参访',
      '来金',
      '金华行',
    ],
  ],
  [
    BUILT_IN_CATEGORY_IDS.jointHandling,
    ['会办', '建议办理', '提案办理', '人大建议', '政协提案', '议案', '主办件', '建议', '提案'],
  ],
  [
    BUILT_IN_CATEGORY_IDS.meetingsAndEvents,
    [
      '全办会',
      '座谈会',
      '论坛',
      '推进会',
      '部署会',
      '例会',
      '研讨会',
      '交流会',
      '开幕式',
      '筹备',
      '旁听',
      '分享会',
      '换届',
      '大会',
      '会议',
      '活动',
    ],
  ],
  [
    BUILT_IN_CATEGORY_IDS.documentsAndDrafting,
    [
      '材料',
      '讲话',
      '发言',
      '汇报',
      '总结',
      '方案',
      '报告',
      '致辞',
      '信息',
      '宣传',
      '简报',
      '公文',
      '起草',
      '拟制',
      '撰写',
      '台账',
      '清单',
      '要点',
    ],
  ],
  [
    BUILT_IN_CATEGORY_IDS.feedback,
    ['征求意见', '反馈', '意见的函', '修改意见', '会签', '规划意见', '纲要意见', '意见'],
  ],
  [
    BUILT_IN_CATEGORY_IDS.trainingAndStudy,
    ['培训', '学习', '研修', '讲座', '读书', '考试', '学法', '轮训', '讲堂', '观摩'],
  ],
  [
    BUILT_IN_CATEGORY_IDS.appraisalAndFiling,
    [
      '考核',
      '绩效',
      '报送',
      '统计',
      '月报',
      '季报',
      '年报',
      '目标责任',
      '一单位一账',
      '填报',
      '填写',
    ],
  ],
  [
    BUILT_IN_CATEGORY_IDS.partyAndLegal,
    [
      '党建',
      '支部',
      '党员',
      '民主生活',
      '组织生活',
      '主题教育',
      '理论学习',
      '党组',
      '党风廉政',
      '廉政',
      '纪检',
      '监察',
      '信访',
      '监督',
      '巡察',
      '整改',
      '专项治理',
      '作风',
      '法治',
      '普法',
      '法规',
      '合法性',
      '公平竞争',
      '行政规范',
      '规章',
      '条例',
      '执法',
    ],
  ],
  [
    BUILT_IN_CATEGORY_IDS.unitedFront,
    ['统战', '双拥', '国防', '军民', '民主党派', '工商联', '侨', '台', '民族', '宗教'],
  ],
];

/** Best-effort category id for a title, or null when no rule matches. */
export function guessCategoryId(title: string): string | null {
  for (const [categoryId, keywords] of CATEGORY_RULES) {
    if (keywords.some((keyword) => title.includes(keyword))) return categoryId;
  }
  return null;
}

/** Legacy category *name* -> seeded id, for records that already carried a category. */
export function categoryIdByLegacyName(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return null;
  return CATEGORY_SEEDS.find((seed) => seed.name === trimmed)?.id ?? null;
}

/** Legacy group *name* -> seeded id. */
export function groupIdByLegacyName(name: string): string | null {
  const trimmed = name.trim();
  const match = defaultGroups().find((group) => group.name === trimmed);
  return match?.id ?? null;
}
