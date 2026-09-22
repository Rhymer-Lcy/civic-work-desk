# UI copy conventions

Conventions that are actually in force in the interface, so a future change can be checked against
something. Not a style essay: every rule below corresponds to a decision already made in the product,
and most of them exist because breaking them once produced a real misunderstanding.

## Terms that must not drift

One term per concept. The left column is what the interface says; the right column is what it means
and what it is **not** called.

| Term | Meaning | Never |
| --- | --- | --- |
| **工作** | the record type, and the destination that lists it | 任务, 事务, 事项列表 |
| **事项** | one work record's subject line (the field label) | 标题, 名称, 主题 |
| **荣誉** | the honours archive and its record type | 奖项, 表彰记录 |
| **台账** | the flat table of every record, for export and print | 列表, 清单, 总表 |
| **进展** | a dated note attached to a record | 日志, 动态, 备注 |
| **回收站** | soft-deleted records, restorable | 垃圾箱, 已删除 |
| **JSON 备份** | the only format that can restore the database | 数据导出, 备份文件（模糊时） |
| **完整还原** | replacing local data with a complete backup, exactly | 恢复, 导入（在还原语境中） |
| **合并导入** | adding records that do not already exist | 导入（在合并语境中） |
| **长期推进** | work with no fixed deadline, judged by status | 长期任务, 持续性工作 |
| **历史遗留** | overdue by more than 30 days | 积压, 陈年旧账 |

Status words are fixed by `STATUS_LABELS_ZH` and must match it exactly: **待办 / 进行中 / 已完成 /
暂缓 / 已取消**. The interface never invents a synonym for a status, because the same word appears in
the ledger, the report and the XLSX export.

## Backup vocabulary, which is where misunderstanding costs the most

- **Only JSON is a backup.** XLSX and DOCX are 报表 / 报告. Copy must never put them in the same
  sentence as 备份 without saying which is which. The sentence used on the dashboard and in the
  first-run page is the canonical one: 只有 JSON 备份可以完整还原本机数据。
- 导出 is what the user does; 备份 is what they get. 导出 XLSX produces a 报表, not a 备份.
- A backup is 完整 or it is not, and "incomplete" always states what was omitted. Never soften this.

## Register

- Plain, professional, no exclamation marks, no encouragement (不要 "太棒了", "搞定").
- Second person is implied, not written: 请先导出备份 rather than 你需要先导出备份.
- Verbs in labels, nouns in headings: a button says 导出 JSON 备份; a section is called 数据与备份.
- No developer vocabulary in ordinary copy. `dataRevision`, IndexedDB, Dexie, 事务 (in the database
  sense), ConstraintError and checksum belong in 设置 → 存储与诊断, and nowhere else. The user-facing
  phrasing for the same fact is 本机数据在生成预览之后发生了变化, not "dataRevision 不一致".

## Messages

- **An error says what happened, what was not done, and what to do next** — in that order, in one
  paragraph. The stale-import refusal is the model:
  本机数据在生成导入预览之后发生了变化，…本次导入已整体中止，未写入任何内容。请…重新生成预览。
- **A destructive confirmation states the quantity and the reversibility**:
  这会删除本机全部 24 条记录及其进展 … 此操作不可撤销。
- **A success message states what was written**, not that something succeeded:
  导入完成：写入 31 条记录、13 条进展。
- Never report success before the work is done. An export toast appears after the file exists.

## Empty states

"No data" and "no matches" are different sentences with different offers:

| Situation | Says | Offers |
| --- | --- | --- |
| Nothing has ever been created | 还没有工作记录 | 新增记录 |
| A filter excluded everything | 没有符合当前筛选条件的记录 + how many exist | 清除全部筛选 |
| Nothing is urgent | 近期没有逾期或临近到期的事项 + the workload totals | nothing — this is good news |

A bare 暂无数据 is not acceptable anywhere: it answers neither "why" nor "what now".

## Numbers, dates and units

- Counts take 条 for records and 项 for checks: 共 24 条, 3 项问题.
- Dates are ISO (`2026-09-22`) in data contexts — lists, tables, exports — because they sort and
  align. Prose may use 9 月 22 日.
- A date range is `2026-10-08 ~ 2026-10-22`.
- Never print a bare wall-clock time without its date in a record context.

## Punctuation (GB/T 15834-2011)

- Chinese quotation marks are “ ” and ‘ ’; the corner brackets 「」 are reserved for naming an
  interface location, e.g. 在「设置 → 回收站」中恢复 — a convention this product uses consistently and
  which should not spread to ordinary quotation.
- Book and document titles take 《》.
- No 、 before 以及 in a list.
- A full-width comma separates clauses; a half-width comma never appears in Chinese prose.
- Leave one space between Chinese text and a Latin word or number when it aids legibility
  (JSON 备份, 共 24 条), and be consistent within a sentence.
