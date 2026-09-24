# Phase 4 — Windows 11 x64 RC2 (field-validation candidate)

**Status: RC2 built, rehearsed on the development workstation, NOT certified.**

RC2 is a distribution-experience pass. It changes how the package installs, looks and explains itself.
It changes **no** application behaviour: the payload is byte-identical to RC1's apart from one
deployment-metadata file, and that is asserted by the build rather than asserted by hand.

RC1 remains published and untouched — tag `windows-v2026.09.24-rc1`, installer SHA-256
`c50c7ecd89d3085c44e780e76f1318cecf49ea2b8f15b82391457ce0bb9fdbb5`.

## 1. The application did not change

|                                  | RC1 | RC2                                  |
| -------------------------------- | --- | ------------------------------------ |
| Application files in the payload | 24  | 24                                   |
| Files differing                  | —   | **1** (`app/deployment-health.json`) |

The one difference is the release id and channel the launcher checks. Every other application byte is
identical, compared manifest-to-manifest between the two tracked payload manifests under
[release/windows/provenance/](../release/windows/provenance/). `src/` and `public/` were not touched in
this pass at all.

## 2. Chinese copy

Authority: [copy-style-zh-CN.md](copy-style-zh-CN.md). Current wording, line by line, with its source
file: [user-visible-copy-zh-CN.md](user-visible-copy-zh-CN.md). Enforced by `npm run audit:copy`.

The substantive changes, and what each one was protecting:

- **规范地址 → 固定访问地址**, plus the origin explained as 浏览器来源（origin）. The old term told a
  user nothing; the new text distinguishes _changing the origin_ (scheme/host/port) from _changing the
  storage container_ (a different browser or browser profile), which RC1's wording conflated.
- **发布完整性 → 程序完整性**, and the verdict now says 校验通过 / 校验未通过 rather than printing a raw
  summary.
- **服务 → 本地服务** everywhere, because this product installs no Windows Service and must not appear to.
- **The safe-process sentence** is now one canonical line — 程序不会强行结束无法确认归属的进程。 —
  replacing RC1's developer-facing aside about the cost of killing the wrong process. The _meaning_ is
  preserved deliberately: this is a safety promise, not a flourish. Technical contexts may add
  这是安全设计：无法确认进程归属时，不执行强制终止操作。
- **SmartScreen**: RC1 said the warning was "not a problem with this program" and named the reason as an
  unpurchased certificate. Both are gone. RC2 states that the build is unsigned, that the warning proves
  nothing either way, that the installer should come only from the project's GitHub Release, and that
  the reader should not install if unsure — and never to disable Defender or SmartScreen.
- **Network**: RC1's "不联网…不向外发送任何东西" claimed more than this program can guarantee. RC2 says
  installation and use do not depend on the internet, that CivicWorkDesk does not upload business data,
  and that the browser's and operating system's own network behaviour is outside its control.
- **Preflight failure**: RC1's 系统未被修改 was too broad — Setup has already extracted its temporary
  files by then. RC2 says 未写入正式安装目录，安装未完成。未创建应用快捷方式，也未启用任何新版本。
- **Diagnostics** are consistently 诊断文件（TXT）.
- **Punctuation**: `「」` → `“”` across the Windows surface, per GB/T 15834—2011.

### What was NOT accepted from the review

- **激活 for 启用** — rejected. "激活" is overloaded by Windows licensing; 启用版本 / 启用校验 describe
  release switching accurately.
- **系统集成项 for 部署集成** — rejected as still technical. 安装项 is the user-facing term; English
  engineering documents keep "deployment integration".
- **固定地址** — not adopted on its own; the user-facing label is the fuller 固定访问地址.
- **Normalising the UOS surface now** — deferred, see §8.

## 3. Installation path

Default remains `%LOCALAPPDATA%\CivicWorkDesk`. RC2 offers the directory page on a **clean** install
(`DisableDirPage=auto`) and suppresses it on upgrade or repair, where `UsePreviousAppDir` supplies the
remembered location. Verified by behaviour, not by reading Inno's documentation: the RC1→RC2 upgrade
test asserts exactly one installed-program entry, still pointing at the original directory.

Accepted: any absolute path on a fixed local volume that the current user can write, including spaces
and Chinese characters.

Rejected, each with its own message and no silent fallback to the default:

| Refused                                                          | Why                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| UNC / network path                                               | an offline-first product must not depend on a server being reachable                 |
| Removable, remote or CD-ROM volume                               | the device can disappear while the local service is running from it                  |
| Drive root                                                       | the uninstaller's "remove the installation directory" step would point at the volume |
| `%SystemRoot%`, Program Files, ProgramData, common program files | need elevation, which this installer does not have and must not request              |
| The user-profile root itself                                     | a folder _inside_ the profile is fine; the root is not an installation directory     |
| Relative path                                                    | has no fixed meaning once the working directory changes                              |
| A component ending in a dot or space                             | Win32 silently rewrites it, so the recorded path and the real one would differ       |
| Reserved Windows characters                                      | unrepresentable                                                                      |

**There is no in-place relocation.** To move an installation: export a JSON backup, uninstall, reinstall
to the new path. Because the canonical origin never changes, the records are unaffected — measured in the
browser suite, not asserted.

### Preflight is now three stages

RC1 asked every question at once against a hard-coded `%LOCALAPPDATA%` path, which is precisely what made
a custom directory impossible. RC2 splits them by the moment at which each can be answered:

| Stage       | When                                                          | Asks                                                                                |
| ----------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `machine`   | `InitializeSetup`, before anything is written                 | Windows 11, x64, Start Menu writable, the bundled checker runs                      |
| `directory` | `NextButtonClick(wpSelectDir)`                                | the chosen path's shape, safety and writability                                     |
| `runtime`   | `PrepareToInstall`, after stopping any previous local service | port 8765, release shape, program integrity, MIME coverage, the bundled server runs |

The directory stage judges the **raw** argument. `filepath.Abs` had been applied first, which turned a
relative path absolute and stripped a trailing dot or space — so three of the shapes the check exists to
refuse were normalised away and reported usable. The acceptance run caught it.

## 4. Icons and shortcuts

The Windows icon is drawn from the same five shapes as `public/icons/icon.svg`, by
[generate-ico.mjs](../scripts/windows/generate-ico.mjs) — no rasteriser, no image dependency,
deterministic. Eight images: 16, 20, 24, 32, 40, 48, 64 as 32-bit BGRA DIBs and 256 as PNG.

16, 20 and 24 are **hand-drawn on the pixel grid**, and 32 and 40 are snapped to it. The document lines
are 13 units in a 512-unit box — 0.41 px at 16 — so scaled they became a uniform pink smear. This was
only visible by rendering a contact sheet and looking at it; no structural check would have found it.

The committed `.ico` is verified against its generator at build time (`--check`), so it cannot become a
stale companion.

Resource objects are produced by [generate-winres.mjs](../scripts/windows/generate-winres.mjs): a
hand-written COFF `.syso` per user-facing binary, carrying RT_ICON, RT_GROUP_ICON and RT_VERSION. **No
external resource tool** — `rsrc` and `goversioninfo` would each add a module dependency to audit for a
fully specified format, and this repository already hand-writes PNG, ZIP and ICO for the same reason.
CGO stays disabled; the `.syso` files are generated at build time and not committed, since they embed
the release id.

`civic-server.exe` and `civic-admin.exe` deliberately get no icon: a user is never meant to run them.

**Desktop shortcut**: an opt-out installer task, `checkedonce`, targeting the stable `bin\civic-launch.exe`
rather than a versioned release binary. Removed on uninstall, and listed explicitly in `[UninstallDelete]`
so a repair-recreated copy cannot be orphaned.

**Start Menu**: one entry at the top level (政务工作记录台) and a 维护工具 subfolder holding
收集诊断信息, 查看运行状态, 停止本地服务, 浏览器兼容性检查 and the uninstaller. RC1 put six shortcuts
side by side, which made "stop the service" look like an ordinary thing to do.

## 5. Diagnostics

**Install failure.** RC1 wrote its preflight report into Setup's temporary directory and told the user to
copy it before the dialog was dismissed — a race an ordinary tester cannot win. RC2 writes
`CivicWorkDesk-安装诊断-YYYYMMDD-HHMMSS.txt` to the Desktop (falling back to the profile root, then TEMP,
showing whichever path worked). A **passing** stage deletes its own report, so an ordinary successful
install leaves nothing behind.

**Privacy.** RC1's report carried the machine name and the account name as fields, and every path carried
the account name again. Both fields are gone, and every line goes through
[internal/redact](../deploy/windows/src/internal/redact/) on the way out, so a path cannot reach the file
by a route the author forgot to wrap:

```
C:\Users\<someone>\AppData\Local\CivicWorkDesk\...  →  %LOCALAPPDATA%\CivicWorkDesk\...
C:\Users\<someone>\Desktop\...                      →  %USERPROFILE%\Desktop\...
D:\Applications\CivicWorkDesk                       →  unchanged
```

A custom directory stays verbatim: it identifies nobody, and losing it would make exactly the
installations RC2 added support for impossible to diagnose. A separate `install root kind` line says
whether the installation is in the default place, which redaction would otherwise hide.

Still absent, and asserted: work records, site-storage contents, cookies, history, passwords, document
contents, the control-token value (reported as _present_ only), and any build-machine or workspace path.

## 6. Provenance

|                    |                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| Go                 | 1.27.1, portable tree, build-time only                                                                                          |
| Build flags        | `-trimpath -buildvcs=false -ldflags="-s -w"`, `CGO_ENABLED=0 GOOS=windows GOARCH=amd64`                                         |
| Installer          | Inno Setup 7.1.0 (x64), portable, licence verified                                                                              |
| Windows resources  | hand-written COFF, no external tool                                                                                             |
| Application commit | `ad65e8f6e186912ae97200264f05ab26181f34e1` (unchanged from Phase 2)                                                             |
| Payload manifest   | [provenance/2026.09.24-win-rc2-payload-SHA256SUMS.txt](../release/windows/provenance/2026.09.24-win-rc2-payload-SHA256SUMS.txt) |

The **payload is bit-reproducible** — two builds of an unchanged tree produce an identical manifest. The
**installer is not**: Inno Setup embeds non-deterministic data, so its SHA-256 identifies one published
artifact rather than what a rebuild yields. The build refuses to overwrite an existing installer without
`--force-installer`, which is what stops a rebuild from silently invalidating a published digest.

## 7. What was measured

| Suite                                                                                                                | Checks               | Failed |
| -------------------------------------------------------------------------------------------------------------------- | -------------------- | ------ |
| [acceptance-deploy.mjs](../scripts/windows/acceptance-deploy.mjs) — installer, HTTP, lifecycle, process identity     | 118                  | 0      |
| [acceptance-rc2-ux.mjs](../scripts/windows/acceptance-rc2-ux.mjs) — paths, icons, shortcuts, menu, diagnostics, copy | 131                  | 0      |
| [acceptance-browser.mjs](../scripts/windows/acceptance-browser.mjs) — Chromium at the origin, incl. relocation       | 70                   | 0      |
| Go unit tests                                                                                                        | 68                   | 0      |
| Vitest                                                                                                               | 330                  | 0      |
| Chromium E2E                                                                                                         | 96                   | 0      |
| Cross-browser (Firefox, WebKit)                                                                                      | 21 passed, 1 skipped | 0      |
| Accessibility                                                                                                        | 14                   | 0      |
| Release-artifact privacy scan                                                                                        | 31 files, 0 findings | 0      |

### Defects RC2's own acceptance found and fixed

1. **Every tool resolved its root from `%LOCALAPPDATA%`**, so a custom-path installation could not launch
   at all (exit 4 on every case). The binaries now derive the root from their own executable path.
2. **The directory check judged a normalised path**, so a relative path and trailing dot/space were
   accepted. It now judges the raw argument.
3. **`{userprofile}` is not an Inno constant.** `InitializeSetup` raised "Unknown constant" and Setup
   died at exit 1 before anything ran. Replaced with `{%USERPROFILE}`.
4. **A passing preflight left a diagnostic on the Desktop.** Three stages meant three files after an
   ordinary successful install. Only a blocking stage keeps its report now.
5. **`civic-admin` created the installation's `logs\` directory during a machine-stage preflight**, so a
   refused install left a folder behind while its own dialog said nothing had been written.

Four further failures were defects in the harness rather than the product, each recorded because it is a
reusable trap: a multi-line PowerShell `@( ... )` array arriving as one space-joined line; a privacy scan
matching the report's own disclaimer for the second time in this project, after the note was rewritten and
the old anchor silently stopped matching; `cleanSlate` deleting the installation directory but leaving
Inno's HKCU key, so `UsePreviousTasks` made a "first" install inherit the previous run's choices; and a
Go-format gate built on `git diff`, which flagged every uncommitted edit as a formatting failure.

## 8. UOS

Not rebuilt, not modified, no `-6`. The frozen artifact's digest is unchanged:
`969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`.

`deploy/uos/` is the source those bytes were built from, so normalising its copy now would leave the tree
and the shipped artifact disagreeing with no release to reconcile them. The work is scheduled in
[uos-next-maintenance.md](uos-next-maintenance.md), and the existing occurrences are pinned to exact
counts by the copy audit so they cannot grow — or shrink — without a deliberate change.

One factual correction was made: [uos-upgrade-recovery.md](uos-upgrade-recovery.md) still said the
installed form had not been validated on the target. That was the pre-sign-off state. The frozen
artifact's own `installedFormTargetValidated=NO` is build-time metadata, and the physical validation
happened afterwards against those same bytes — which is why the artifact is not rebuilt to change it.

## 9. Known RC2 limitations

- **Windows compatibility is not certified.** One machine, one operator, one browser engine.
- **The installer is unsigned** — verified: `Get-AuthenticodeSignature` reports `NotSigned` for the
  installer and all four binaries. Evaluating Authenticode signing before broad organisational
  distribution is a separate backlog item and was deliberately not a blocker here.
- The directory page cannot be exercised in a silent install, so `DisableDirPage=auto` is verified through
  `/DIR=` and through the upgrade path rather than by driving the wizard UI.
- UNC rejection is verified against a path shape, not against a real unreachable share.
- `npm audit` reports 2 moderate advisories: `exceljs → uuid` GHSA-w5hq-g745-h8pq, pre-existing,
  documented as unreachable and accepted in [dependencies.md](dependencies.md). No dependency changed in
  this pass.
- Nothing is known about managed-desktop policy, endpoint security software, redirected profiles, or 360
  Browser specifically.
