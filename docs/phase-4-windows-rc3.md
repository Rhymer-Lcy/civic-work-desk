# Phase 4 — Windows 11 x64 RC3 (field-validation candidate)

**Status: RC3 built, rehearsed on the development workstation, NOT certified.**

RC3 is a narrow corrective pass. It fixes four defects an independent GitHub audit found in RC2 and
changes nothing else. The application payload is byte-identical to RC2's apart from one
deployment-metadata file, and `civic-server.exe` is byte-identical too — the server was not rebuilt in
any meaningful sense.

RC2 remains published and untouched: tag `windows-v2026.09.24-rc2`, installer SHA-256
`5d36bb168c73e0cc0c4ecd91845178fac1883a549d1da0b19cc493b2c5ce70b3`. RC2 is superseded for field
validation. It is not unsafe, and none of its assets were modified or deleted.

| Artifact         | Value                                                              |
| ---------------- | ------------------------------------------------------------------ |
| Installer        | `CivicWorkDesk-Windows-x64-2026.09.24-rc3-Setup.exe`               |
| Size             | 6,894,533 bytes                                                    |
| SHA-256          | `4b8bc1d2d80446f3866d88dc6293446c79a1ef1908c28aa9b710b076bdf71e96` |
| Source commit    | `70174f01480a146b68c5619d24e02c72a02efb6c`                         |
| Built at         | 2026-09-24T14:01:09Z                                               |
| Admin rights     | not required                                                       |
| Canonical origin | `http://127.0.0.1:8765`                                            |

## 1. Broken artifact↔source provenance

RC2's VERSION recorded `deploymentCommit=9adf28af4762da2e8ed97691b55182f5642038c1`. GitHub cannot
resolve that SHA, so the artifact's claim to bind itself to exact public source was unverifiable.

**Root cause, established rather than guessed.** The freeze build read `git rev-parse HEAD` while HEAD
pointed at an unpushed sanitization commit. A later non-interactive rebase — run to shorten three
over-length commit subjects — rewrote that commit to `69738fa`, and the original ceased to exist. The
`phase=Phase 4 Windows RC1 (field-validation candidate)` line inside an RC2 payload had the same
shape of cause: a hand-typed string nothing downstream read.

**The fix is two deliberately distinct commits.**

| Field                    | Meaning                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deploymentSourceCommit` | the public commit holding all source affecting the payload and installer. Frozen before the build.                                                                                       |
| `releaseRecordCommit`    | the later commit holding generated provenance and documentation. The tag points at it. **Never embedded in the artifact** — that self-reference is what made the first attempt circular. |

[assert-release-provenance.mjs](../scripts/windows/assert-release-provenance.mjs) is now **step 0** of
the build: nothing is produced until the SHA is proven. It checks the 40-hex shape, `git cat-file -e`,
ancestry of the public Phase-4 branch, that the local branch equals `origin/` (so "reachable" is a
statement about GitHub and not about one machine's reflog), that `gh api …/commits/<sha>` resolves it,
and that GitHub lists it on the branch.

**It was proven able to fail before being relied on.** Run against RC2's dangling SHA it reports 3 of
6 checks failed and exits 1:

```
[FAIL] it is reachable from phase-4/windows-offline-distribution  --  NOT an ancestor — it was rewritten or never pushed
[FAIL] GitHub resolves the SHA  --  gh: No commit found for SHA: 9adf28af… (HTTP 422)
[FAIL] GitHub reports it on the public Phase-4 branch  --  100 commit(s) examined
```

Exit codes were checked on every bad input: dangling → 1, all-zero → 1, malformed → 1, absent → 2.

The `--verify-built` mode re-reads the built VERSION and additionally asserts the retired
`deploymentCommit` key is gone, that `deploymentSourceCommit` is present, and that
`releaseRecordCommit` is **absent from the artifact**.

### The workflow that was actually followed

1. every source, copy and privacy fix made;
2. committed as five atomic commits;
3. **pushed** (`19dc996..70174f0`);
4. GitHub asked to resolve `70174f01480a146b68c5619d24e02c72a02efb6c` — it does;
5. frozen as `deploymentSourceCommit`;
6. RC3 built from that exact SHA, passed to the build explicitly rather than inferred from HEAD;
7. that commit has not been amended, rebased or reworded since, and will not be.

One later commit (`a036f0e`) corrects a test assertion. It touches no payload and no installer input,
so the artifact's binding to `70174f01` is unaffected — and because the provenance check tests
**ancestry** rather than equality with the branch head, it still passes.

## 2. Release-candidate identity leakage

RC2's installer told users, in its own Properties dialog, that it was RC1 —
`VersionInfoDescription={#CivicAppNameEn} Windows x64 RC1` was hard-coded in the installer source.

The `.iss` now carries no release-candidate number at all. The label arrives as `CivicReleaseLabel`,
which the build **derives** from the release id rather than accepting as a second hand-typed value:

```js
const releaseLabel = (releaseId.split('-').pop() ?? '').toUpperCase();
if (!/^RC[0-9]+$/.test(releaseLabel)) fatal(...);
```

and `#ifndef CivicReleaseLabel / #error` makes a build that forgets to pass it fail instead of
producing an unlabelled installer.

[assert-release-identity.mjs](../scripts/windows/assert-release-identity.mjs) checks this
**contextually, not by grep.** It reads the `VersionInfoDescription` line out of the tracked `.iss`
and requires it to be parameterised and to contain no RC literal; it reads `FileDescription` and
`ProductVersion` out of the built installer and the version resources out of `civic-launch.exe` and
`civic-diag.exe`; it reads the payload `VERSION` and `deployment-health.json`; and it reads the tester
notice. Earlier-release mentions are rejected only where they are not explained — a line describing
supersession is allowed, because forbidding it would force the notice to lie about what RC3 replaces.

**Proven able to fail, against real data rather than a synthetic mutation.** Pointed at RC2's actual
artifact it catches 5 failures including the two the audit reported:

```
[FAIL] installer FileDescription names THIS release and no earlier one  --  CivicWorkDesk Windows x64 RC1 (field-validation candidate)
[FAIL] VERSION phase names THIS release  --  Phase 4 Windows RC1 (field-validation candidate)
```

Historical RC1 and RC2 documents continue to say RC1 and RC2. That is correct: they record what those
releases were.

## 3. The ambiguous Chinese sentence

RC2 said:

> 无法停止正在运行的政务工作记录台（`<OldAdmin>` 无法执行）。

The parenthesis reads as though **the application** could not run, when what failed was the stop
tool — and it put a long executable path inside the primary sentence. RC3 says:

> 无法停止正在运行的政务工作记录台：停止工具无法执行。
>
> 请从开始菜单运行“维护工具 → 停止本地服务”，然后重新安装。
>
> 技术细节（反馈时请一并提供）：
> `<path>`

The subject is explicit, the primary sentence carries no path, and the path survives as a labelled
technical detail for support.

**A defect introduced by this very fix, caught in review of it.** The first version of this change
ended with `DiagnosticSentence()`. That function reports the last preflight report — and a _passing_
stage deletes its own report (an RC2 fix), so on the ordinary path into this branch the variable is
empty and the sentence would have announced that the Desktop, profile root and temp directory were
all unwritable. An invented failure, printed to a user already dealing with a real one. The call
ordering was the proof: the branch sits in `PrepareToInstall`, _above_ that function's own
`RunPreflight('runtime', …)` call, so no stage had yet written a report that this install would keep.

`copy-audit.mjs` gained `无法执行）` as a retired phrase and the new sentence as a required statement.
Its mutation test now plants **17/17** retired phrases and detects **7/7** required statements as
absent when removed.

## 4. Custom-path diagnostic privacy

RC2's diagnostic report printed a user-chosen installation directory verbatim, and RC2's document
justified it by claiming such a path "identifies nobody". **That claim was false.** These are all
legal installation directories:

```
D:\张三\政务工作记录台
D:\Users\Alice\CivicWorkDesk
D:\某单位\李某\CivicWorkDesk
```

A report that promises to carry no account name while printing any of them is making a promise it
cannot keep. The claim is retracted in [phase-4-windows-rc2.md](phase-4-windows-rc2.md) and the rule
is now written into [copy-style-zh-CN.md](copy-style-zh-CN.md) §9.1.

A non-default root is reported as `D:\<CUSTOM_INSTALL_ROOT>`. What masking loses is recovered by
reporting the path's **characteristics**, which answer the questions a custom-path bug actually
raises and name nobody:

| Reported             | Example  |
| -------------------- | -------- |
| `install root kind`  | `custom` |
| `install volume`     | `D:`     |
| `path has spaces`    | `no`     |
| `path has non-ASCII` | `yes`    |
| `path depth`         | `2`      |
| `path length`        | `13`     |
| `path writable`      | `yes`    |

**Why it is registered centrally.** `redact.MaskInstallRoot` adds the root to the same rule set every
line already passes through, rather than rewriting the fields somebody remembered to wrap. That is the
difference between "the fields I thought of are clean" and "the file is clean" — the root cannot reach
the report through a log line, an error string, a health document or an executable path.

**A real hole the adversarial test found.** `Paths()` originally replaced the native and forward-slash
spellings. A custom root of `D:\某单位\李某\CivicWorkDesk` still leaked through the **JSON** spelling
— doubled backslashes, as a health document or state file quoted into an error message carries it.
Three spellings are now replaced. The test that caught it is
[customroot_test.go](../deploy/windows/src/internal/redact/customroot_test.go), and it includes
`TestMaskingIsNotJustDeletingEverything` so that "the name is absent" cannot be satisfied by emitting
nothing.

**The stale assertion that was holding the defect in place.** The UX suite contained
`check(report.includes(c.dir), 'diagnostics keep the custom path verbatim')` — RC2's encoding of the
retracted claim. It failed on the corrected build, which is exactly what it should have done. It was
**inverted, not deleted**, so the property stays pinned in the opposite direction.

The diagnostic privacy note no longer claims a custom path is anonymous; it states what is actually
guaranteed.

## 5. The TEMP fallback is not durable

RC2 described all three diagnostic fallback locations as equivalent. Setup's temp directory is deleted
when Setup exits, so "诊断文件已保存至：`<temp path>`" was the same false promise RC1 made. The three
cases are now distinguished:

| Location               | Message                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| Desktop, profile root  | 诊断文件已保存至：…                                                                   |
| Setup's temp directory | 诊断文件已写入临时目录：… / 该目录会在安装程序退出时被清理。/ 请先将该文件另存到桌面… |
| none writable          | 无法写出诊断文件（桌面、用户目录与临时目录均不可写）。                                |

The last one also corrects a count: RC2 said 桌面与用户目录都不可写 — two places, when three had been
tried. Asserted by reading the installer source, because provoking an unwritable Desktop on a real
machine would mean damaging the operator's own profile.

## 6. The application payload did not change

|                                  | RC2 | RC3                                  |
| -------------------------------- | --- | ------------------------------------ |
| Application files in the payload | 24  | 24                                   |
| Files differing                  | —   | **1** (`app/deployment-health.json`) |

Everything else that differs is a deployment file that had to change:

| File                      | Why it differs                          |
| ------------------------- | --------------------------------------- |
| `VERSION`                 | release id, label, source commit        |
| `SHA256SUMS.txt`          | digests of the above                    |
| `server/civic-admin.exe`  | preflight reports path characteristics  |
| `server/civic-diag.exe`   | custom-root masking                     |
| `server/civic-launch.exe` | rebuilt against the redaction package   |
| `server/civic-server.exe` | **byte-identical to RC2** — not changed |

`src/`, `public/`, `index.html`, `vite.config.ts` and `tests/` were not touched in this pass at all;
`git diff` over those paths is empty. Independently of that, `dist/` rebuilt from this source is
byte-identical to RC2's shipped `app/` across all 23 files vite produces.

## 7. What was measured

Every Windows gate was run against the **actual RC3 installer bytes**.

| Suite                                                                                              | Checks               | Failed |
| -------------------------------------------------------------------------------------------------- | -------------------- | ------ |
| [acceptance-deploy.mjs](../scripts/windows/acceptance-deploy.mjs)                                  | 118                  | 0      |
| [acceptance-ux.mjs](../scripts/windows/acceptance-ux.mjs)                                          | 176                  | 0      |
| [acceptance-browser.mjs](../scripts/windows/acceptance-browser.mjs)                                | 70                   | 0      |
| [assert-release-provenance.mjs](../scripts/windows/assert-release-provenance.mjs) `--verify-built` | 11                   | 0      |
| [assert-release-identity.mjs](../scripts/windows/assert-release-identity.mjs)                      | 15                   | 0      |
| [scan-release-artifact.mjs](../scripts/windows/scan-release-artifact.mjs)                          | 31 files, 0 findings | 0      |
| Copy audit + mutation                                                                              | 17/17 + 7/7          | 0      |
| Go unit tests (5 packages, incl. 7 new custom-root tests)                                          | 75                   | 0      |
| Vitest                                                                                             | 330                  | 0      |
| Accessibility                                                                                      | 14                   | 0      |
| Cross-browser (Firefox, WebKit)                                                                    | 21 passed, 1 skipped | 0      |
| UOS static lint / archive regression                                                               | 127 files / 55       | 0      |
| Prettier, ESLint, `tsc --noEmit`, `gofmt`, `go vet`, static security scan                          | clean                | 0      |

### Gates that failed first, and what changed

Recorded rather than quietly re-run:

1. **ESLint, 3 errors.** `no-regex-spaces` on a column-aligned assertion and two `no-irregular-whitespace`
   from literal BOMs written into a PowerShell helper. Fixed by matching label padding tolerantly
   (`/path length *: [0-9]+/`) and by building the BOM from `String.fromCharCode(0xfeff)`. The tolerant
   form is also the better assertion: it pins that the characteristic is reported, not that its colon
   lands in a particular column.
2. **`acceptance-ux.mjs` three FAILs on the first RC3 run** — `diagnostics keep the custom path verbatim`,
   for the space / Chinese / other-drive cases. This was the suite correctly refusing the fix: the
   assertion encoded RC2's retracted claim. Inverted, and the run went 173 → 176 checks, 0 failed.
3. **`PREVIOUS_SETUP` still named the RC1 installer** after the file rename, so the upgrade path was
   testing the wrong predecessor. Repointed at RC2, which is what a colleague will actually be upgrading
   from.
4. **The copy audit was first invoked with a flag that does not exist** (`--self-test`). It was silently
   ignored and ran an ordinary audit that passed, which looked like a mutation test having succeeded. The
   real flag is `--mutate`. Worth recording because the failure mode was a green result, not a red one.

## 8. Known defect NOT introduced by RC3

`npm run test:e2e` fails 2 of 96. **Neither failure is caused by this pass and neither is a product
defect**, and RC2's document recorded 0 for the same gate — a number that does not reproduce.

| Test                                                                 | Behaviour                               |
| -------------------------------------------------------------------- | --------------------------------------- |
| `smoke.spec.ts:191` ledger at phone width (`chromium-mobile`)        | fails 4/4 in sequence, passes 5/5 alone |
| `phase-2-ux.spec.ts:282` settings section index (`chromium-desktop`) | intermittent, ~2 of 3                   |

Evidence that RC3 is not the cause:

- `git diff` over `src/`, `public/`, `index.html`, `vite.config.ts` and `tests/` is empty for this pass;
- `dist/` rebuilds byte-identical to RC2's shipped payload, 23/23 files;
- `src/` and both test files last changed in `64b8e3e`, long before RC2;
- the Playwright browser builds date from 2026-09-21, before either candidate was built.

Evidence that the product is correct: the captured accessibility snapshot shows the record **is**
visible at phone width, as a card. The ledger renders a table and a card list and hides one by width;
`getByText(...).first()` resolves to the table's `<td>`, which is the hidden one on a phone.
`gotoApp` clears storage over CDP without waiting for the clear to be observed, which is what makes
the outcome order-dependent.

The fix is one line in a test selector — target the visible variant, or use `getByRole('article')` as
the neighbouring tests already do. It is **not applied here**, because RC3's scope excludes application
and test-suite behaviour, and because choosing between fixing the selector and fixing the reset helper
is a call for whoever owns that suite.

## 9. Unchanged by RC3

- **The UOS release.** `civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz` still digests to
  `969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`, and `git status` over
  `release/`, `deploy/uos/` and `scripts/uos/` is empty.
- **Licensing.** `private: true`, `license: UNLICENSED`, no `LICENSE` file. Publicly readable source,
  all rights reserved.
- **Signing.** The build is unsigned; SmartScreen will warn. The tester notice says the warning proves
  nothing either way, that the installer should come only from the project's GitHub Release, and that a
  reader who is unsure should not install it. It never suggests disabling Defender or SmartScreen.
- **Binding.** `127.0.0.1:8765` only. A busy port fails loudly; an unrelated process is never killed.
- **Every RC2 improvement** listed in [phase-4-windows-rc2.md](phase-4-windows-rc2.md) — custom paths
  with safe-path validation, three-stage preflight, icons and shortcuts, Start Menu grouping,
  install-failure diagnostics, path redaction, Chinese copy governance — is preserved and re-proved by
  the 176-check UX suite.

## 10. Still not certified

Windows compatibility is **not** certified by this build. Everything above was measured on one
development workstation. `targetTested=NO` — no colleague machine has run this build. That is what
field validation is for, and it is the reason RC3 is a prerelease.
