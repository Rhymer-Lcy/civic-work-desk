/**
 * The Phase-2 demo dataset, as data.
 *
 * Separated from the generator so the content can be reviewed as content: thirty-one records whose
 * only job is to put every state the UI must handle on screen at once. Read it as a specification of
 * what the interface has to survive, not as a seed file — nothing here ever reaches production, and
 * first run stays empty (§7).
 *
 * ## Everything is fictional
 *
 * Organisations, people, document numbers and honours are invented. Phone numbers come from the
 * `138-0013-xxxx` documentation block reserved for examples. No value is derived from, or resembles,
 * any real record.
 *
 * ## Why the dates are absolute
 *
 * Deadline state (overdue / due today / upcoming / stale backlog) is a function of *today*, so a
 * fixture with relative dates would show different states every day and could not back a screenshot.
 * Every date here is anchored on **DEMO_TODAY**, and the Playwright helper pins the browser clock to
 * the same instant, which makes the rendered states reproducible on any machine on any day.
 */

export const DEMO_TODAY = '2026-09-22';

/** The instant the browser clock is pinned to. Local noon, so no timezone can shift the date. */
export const DEMO_NOW = '2026-09-22T12:00:00';

export interface DemoWork {
  readonly title: string;
  /** `occurredOn`: a plain date, a range, or free text that no calendar filter can bucket. */
  readonly occurred:
    string | { readonly start: string; readonly end: string } | { readonly text: string };
  readonly status: 'todo' | 'in-progress' | 'completed' | 'deferred' | 'cancelled';
  readonly statusLabel?: string;
  readonly requirement?: string;
  readonly reportDeadline?: string;
  readonly completionDeadline?: string;
  readonly completedOn?: string;
  /** Built-in category key from `BUILT_IN_CATEGORY_IDS`, or `custom` for the added one. */
  readonly category?: string;
  /** Built-in group key from `BUILT_IN_GROUP_IDS`, or `custom`, or omitted. */
  readonly group?: string;
  readonly longTerm?: boolean;
  readonly unit?: string;
  readonly contact?: string;
  readonly phone?: string;
  readonly remark?: string;
  readonly progress?: readonly { readonly on?: string; readonly note: string }[];
  /** Moved to the Trash after creation, so the Trash and the restore path have content. */
  readonly trashed?: boolean;
}

export interface DemoHonor {
  readonly title: string;
  readonly awarded: string;
  readonly honorType: string;
  readonly level: string;
  readonly issuingOrg: string;
  readonly documentNo?: string;
  readonly personalRole?: string;
  readonly evidenceLocation?: string;
  /** Index into `DEMO_WORK` (pre-trash order) whose record this honour is linked to. */
  readonly linkedWorkIndex?: number;
  readonly remark?: string;
}

/**
 * Work records.
 *
 * Deliberate coverage, relative to 2026-09-22:
 *   - overdue by days and by months (the second is stale backlog, > 30 days);
 *   - due today; due in 3 and 6 days; due next month;
 *   - every status including deferred and cancelled;
 *   - long-term work with and without a deadline;
 *   - a date range and a free-text date, which no year/month filter can bucket;
 *   - long titles, long remarks, and records with almost nothing filled in;
 *   - two records in the Trash.
 */
export const DEMO_WORK: readonly DemoWork[] = [
  {
    title: '中非经贸博览会配套活动方案报审',
    occurred: '2026-09-02',
    status: 'in-progress',
    requirement: '9 月 22 日前将配套活动方案报市外办审核，附经费预算与安保方案',
    reportDeadline: '2026-09-22',
    completionDeadline: '2026-10-20',
    category: 'africaCooperation',
    group: 'fixed',
    unit: '市商务局对外贸易处',
    contact: '周敏华',
    phone: '138-0013-8001',
    remark: '安保方案需与市公安局治安支队会签后一并报送。',
    progress: [
      { on: '2026-09-05', note: '已完成初稿，经费预算部分待财务处复核。' },
      { on: '2026-09-15', note: '与安保部门第一次会商，确认场地出入口方案。' },
      { on: '2026-09-19', note: '财务处复核意见已回，按意见调整预算表第 3 项。' },
    ],
  },
  {
    title: '与圣保罗市友好城市结好二十周年纪念活动筹备',
    occurred: '2026-08-18',
    status: 'in-progress',
    requirement: '拟定纪念活动总体方案，报市政府分管领导审定',
    reportDeadline: '2026-09-10',
    completionDeadline: '2026-11-30',
    category: 'sisterCities',
    group: 'longTerm',
    longTerm: true,
    unit: '市友协秘书处',
    contact: '罗承宇',
    phone: '138-0013-8002',
    remark: '对方市政府希望将青少年交流纳入纪念活动框架。',
    progress: [
      { on: '2026-08-25', note: '与对方市外办视频沟通，初步确定 11 月中旬时间窗。' },
      { on: '2026-09-12', note: '方案第二稿完成，青少年交流部分待教育局补充。' },
    ],
  },
  {
    title: '省人大代表建议第 072 号办理答复',
    occurred: '2026-07-10',
    status: 'todo',
    requirement: '会同市发改委形成书面答复，报省人大常委会办公厅',
    reportDeadline: '2026-08-05',
    category: 'jointHandling',
    group: 'supervised',
    unit: '省人大常委会办公厅联络处',
    contact: '陈志刚',
    phone: '138-0013-8003',
    remark: '已两次延期，需在本月内定稿。',
    progress: [{ on: '2026-08-01', note: '第一次延期申请获同意，新时限 8 月 5 日。' }],
  },
  {
    title: '重点外资项目走访服务台账更新',
    occurred: '2026-09-22',
    status: 'todo',
    requirement: '本周内完成 6 家重点外资企业走访并更新服务台账',
    reportDeadline: '2026-09-22',
    completionDeadline: '2026-09-26',
    category: 'hostingAndVisits',
    group: 'fixed',
    unit: '市投资促进局',
    contact: '黄雅琴',
    phone: '138-0013-8004',
  },
  {
    title: '外事礼品管理办法修订征求意见',
    occurred: '2026-09-16',
    status: 'todo',
    requirement: '9 月 25 日前反馈修订意见',
    reportDeadline: '2026-09-25',
    category: 'documentsAndDrafting',
    unit: '市机关事务管理局',
    contact: '许文彬',
    phone: '138-0013-8005',
    remark: '重点关注第十二条关于礼品登记时限的表述。',
  },
  {
    title: '第四季度外事接待计划编制',
    occurred: '2026-09-20',
    status: 'todo',
    requirement: '汇总各部门接待需求，形成季度计划',
    reportDeadline: '2026-09-28',
    completionDeadline: '2026-09-30',
    category: 'hostingAndVisits',
    group: 'fixed',
    unit: '市政府办公室秘书科',
    contact: '沈亦凡',
    phone: '138-0013-8006',
  },
  {
    title: '涉外突发事件应急预案桌面演练',
    occurred: '2026-10-12',
    status: 'todo',
    requirement: '组织一次桌面推演，覆盖领事通报与媒体应对流程',
    completionDeadline: '2026-10-16',
    category: 'custom',
    group: 'fixed',
    unit: '市应急管理局指挥中心',
    contact: '方启元',
    phone: '138-0013-8007',
  },
  {
    title: '援外培训班学员接待与课程协调',
    occurred: { start: '2026-10-08', end: '2026-10-22' },
    status: 'todo',
    requirement: '协调授课单位、住宿与参观路线',
    category: 'africaCooperation',
    group: 'custom',
    unit: '省国际交流服务中心',
    contact: '邓舒云',
    phone: '138-0013-8008',
    remark: '培训周期跨两周，按区间日期登记。',
  },
  {
    title: '对口援建项目年度验收材料准备',
    occurred: { text: '待定（11 月前）' },
    status: 'todo',
    requirement: '待上级明确验收时间后启动',
    category: 'custom',
    group: 'custom',
    unit: '省援建工作办公室',
    contact: '尹博翰',
    phone: '138-0013-8009',
    remark: '日期尚未确定，按文字日期登记，不参与年月筛选。',
  },
  {
    title: '外事干部涉外礼仪专题培训',
    occurred: '2026-09-11',
    status: 'completed',
    requirement: '完成一期专题培训并归档签到表',
    completionDeadline: '2026-09-18',
    completedOn: '2026-09-17',
    category: 'trainingAndStudy',
    unit: '市委党校培训处',
    contact: '谷明莉',
    phone: '138-0013-8010',
    progress: [{ on: '2026-09-17', note: '培训完成，28 人参加，签到表与讲义已归档。' }],
  },
  {
    title: '上半年外事工作总结报告',
    occurred: '2026-07-02',
    status: 'completed',
    requirement: '形成上半年工作总结，报市政府办公室',
    reportDeadline: '2026-07-20',
    completedOn: '2026-07-18',
    category: 'documentsAndDrafting',
    unit: '市政府办公室',
    contact: '韦嘉树',
    phone: '138-0013-8011',
    progress: [{ on: '2026-07-18', note: '定稿报送，办公室已签收。' }],
  },
  {
    title: '国际友城青少年书画交流展布展',
    occurred: '2026-08-06',
    status: 'completed',
    requirement: '完成展陈布置与开幕活动',
    completedOn: '2026-08-09',
    category: 'meetingsAndEvents',
    unit: '市文化旅游广电局',
    contact: '柳静怡',
    phone: '138-0013-8012',
    remark: '共展出作品 64 幅，其中友城来稿 31 幅。',
  },
  {
    title: '涉外企业用工政策宣讲会',
    occurred: '2026-09-08',
    status: 'completed',
    completedOn: '2026-09-08',
    category: 'meetingsAndEvents',
    unit: '市人力资源和社会保障局',
    contact: '祁云松',
    phone: '138-0013-8013',
  },
  {
    title: '外事系统安全保密自查',
    occurred: '2026-09-01',
    status: 'in-progress',
    requirement: '按季度开展自查并形成台账',
    completionDeadline: '2026-09-30',
    category: 'partyAndLegal',
    group: 'fixed',
    unit: '市保密局',
    contact: '乔慎行',
    phone: '138-0013-8014',
    longTerm: true,
    progress: [{ on: '2026-09-09', note: '完成涉密文件柜与终端排查，两项整改已落实。' }],
  },
  {
    title: '外事接待经费决算核对',
    occurred: '2026-09-14',
    status: 'in-progress',
    requirement: '与财务处核对三季度接待经费支出明细',
    completionDeadline: '2026-10-10',
    category: 'financeAndLogistics',
    unit: '市财政局行政政法处',
    contact: '闻人骥',
    phone: '138-0013-8015',
  },
  {
    title: '统战对象走访联系（涉外侨务口）',
    occurred: '2026-09-05',
    status: 'in-progress',
    requirement: '每季度走访联系不少于 10 人次',
    category: 'unitedFront',
    group: 'longTerm',
    longTerm: true,
    unit: '市侨联',
    contact: '慕容瑾',
    phone: '138-0013-8016',
    remark: '长期推进事项，无固定时限。',
    progress: [
      { on: '2026-08-20', note: '第三季度已走访 6 人次。' },
      { on: '2026-09-05', note: '补充走访 3 人次，累计 9 人次。' },
    ],
  },
  {
    title: '友城合作项目库年度维护',
    occurred: '2026-06-15',
    status: 'in-progress',
    requirement: '核对并更新项目库信息，剔除已终止项目',
    category: 'sisterCities',
    group: 'longTerm',
    longTerm: true,
    unit: '市友协秘书处',
    contact: '罗承宇',
    phone: '138-0013-8002',
  },
  {
    title: '涉外法律服务需求调研',
    occurred: '2026-05-20',
    status: 'deferred',
    statusLabel: '暂缓（等待上级口径）',
    requirement: '形成调研报告并提出服务清单建议',
    reportDeadline: '2026-06-30',
    category: 'partyAndLegal',
    unit: '市司法局',
    contact: '澹台舜',
    phone: '138-0013-8017',
    remark: '等待省级统一口径后再推进。',
    progress: [{ on: '2026-06-28', note: '经请示暂缓，待省厅明确口径。' }],
  },
  {
    title: '境外展会参展补贴申报（已取消）',
    occurred: '2026-04-11',
    status: 'cancelled',
    statusLabel: '已取消（展会延期）',
    category: 'financeAndLogistics',
    unit: '市商务局',
    contact: '周敏华',
    phone: '138-0013-8001',
    remark: '主办方延期至次年，本年度申报取消。',
  },
  {
    title: '外事考核指标填报（三季度）',
    occurred: '2026-09-19',
    status: 'todo',
    requirement: '按新指标口径填报并附说明',
    reportDeadline: '2026-10-08',
    category: 'appraisalAndFiling',
    group: 'supervised',
    unit: '市考核办',
    contact: '扶苏',
    phone: '138-0013-8018',
  },
  {
    title: '群众来信办理：涉外婚姻登记咨询答复',
    occurred: '2026-09-13',
    status: 'completed',
    completedOn: '2026-09-16',
    reportDeadline: '2026-09-18',
    category: 'feedback',
    unit: '市民政局婚姻登记处',
    contact: '公孙瑜',
    phone: '138-0013-8019',
  },
  {
    title: '涉外舆情监测与研判周报',
    occurred: '2026-09-21',
    status: 'in-progress',
    requirement: '每周一报送研判周报',
    category: 'custom',
    group: 'fixed',
    longTerm: true,
    unit: '市委宣传部舆情中心',
    contact: '宗政衡',
    phone: '138-0013-8020',
  },
  {
    title: '外事车辆与会议室调度规则修订',
    occurred: '2026-08-28',
    status: 'todo',
    requirement: '修订调度规则，明确优先级与冲突处理',
    completionDeadline: '2026-10-31',
    category: 'financeAndLogistics',
    unit: '市机关事务管理局',
    contact: '许文彬',
    phone: '138-0013-8005',
  },
  {
    title: '涉非投资合作政策汇编（长期）',
    occurred: '2026-03-04',
    status: 'in-progress',
    requirement: '持续收集并汇编政策文件，季度更新一次',
    category: 'africaCooperation',
    group: 'longTerm',
    longTerm: true,
    unit: '市商务局对外贸易处',
    contact: '周敏华',
    phone: '138-0013-8001',
    remark: '长期事项，无到期日；季度更新。',
    progress: [{ on: '2026-07-01', note: '第二季度更新完成，新增 11 份文件。' }],
  },
  {
    title: '已撤销的重复登记记录',
    occurred: '2026-09-03',
    status: 'todo',
    category: 'meetingsAndEvents',
    unit: '市文化旅游广电局',
    remark: '与另一条记录重复，移入回收站。',
    trashed: true,
  },
  {
    title: '误填的测试记录（待清理）',
    occurred: '2026-09-04',
    status: 'todo',
    remark: '录入测试遗留，移入回收站。',
    trashed: true,
  },
];

/** Honours. Two are linked to work records, so the link affordance has something to show. */
export const DEMO_HONORS: readonly DemoHonor[] = [
  {
    title: '中非经贸合作服务先进集体',
    awarded: '2026-06-20',
    honorType: '表彰（先进集体/个人）',
    level: '省级',
    issuingOrg: '省商务厅',
    documentNo: '湘商奖〔2026〕7 号',
    personalRole: '主要完成人',
    evidenceLocation: '档案室 2026-荣誉-03',
    linkedWorkIndex: 0,
    remark: '表彰文件与奖牌照片已归档。',
  },
  {
    title: '友好城市工作突出贡献奖',
    awarded: '2026-05-12',
    honorType: '表彰（先进集体/个人）',
    level: '市级',
    issuingOrg: '市人民政府外事办公室',
    documentNo: '市外奖〔2026〕2 号',
    personalRole: '参与人',
    evidenceLocation: '档案室 2026-荣誉-01',
    linkedWorkIndex: 1,
  },
  {
    title: '全国援外培训优秀组织单位',
    awarded: '2025-12-08',
    honorType: '表彰（先进集体/个人）',
    level: '国家级',
    issuingOrg: '国家国际发展合作署',
    documentNo: '国合表〔2025〕19 号',
    personalRole: '主要完成人',
    evidenceLocation: '档案室 2025-荣誉-11',
  },
  {
    title: '机关文明单位（复评通过）',
    awarded: '2026-02-26',
    honorType: '荣誉称号',
    level: '市级',
    issuingOrg: '市文明办',
    documentNo: '市文明〔2026〕4 号',
    evidenceLocation: '档案室 2026-荣誉-02',
  },
  {
    title: '外事系统岗位技能竞赛三等奖',
    awarded: '2026-04-18',
    honorType: '竞赛获奖',
    level: '县区级',
    issuingOrg: '市总工会',
    personalRole: '个人',
    remark: '个人奖项，证书在本人处。',
  },
];
