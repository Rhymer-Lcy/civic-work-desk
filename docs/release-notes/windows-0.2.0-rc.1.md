**A field-validation candidate, NOT a certified release.** Accepted end to end on **one** Windows 11 x64
development workstation (build 26200), from these exact installer bytes, as an ordinary non-elevated
user, in installed Microsoft Edge 154.0.4258.37. No colleague's machine has run this build yet.
`windowsCompatibilityCertified=NO`.

It supersedes RC3 for new field validation. RC1, RC2 and RC3 remain published and unmodified.

## Artifact

|                          |                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Installer                | `CivicWorkDesk-Windows-x64-0.2.0-rc.1-Setup.exe`                                                                                                                 |
| Size                     | 6,973,273 bytes                                                                                                                                                  |
| SHA-256                  | `ebb594005f8765959bf91d3ef63624c885f249a3a095a4825ced9acf81e72c1d`                                                                                               |
| Version                  | `0.2.0-rc.1` (Windows file version `0.2.0.0`)                                                                                                                    |
| Publisher                | `Rhymer-Lcy`                                                                                                                                                     |
| Engineering release id   | `2026.09.30-win-0.2.0-rc.1`                                                                                                                                      |
| Deployment source commit | [`5ccf809da96fa7ee72dc1fbc1b82debfef7d4514`](https://github.com/Rhymer-Lcy/civic-work-desk/commit/5ccf809da96fa7ee72dc1fbc1b82debfef7d4514)                      |
| Product baseline         | [`a0e0a4ce73e205823e3f6c0fa1d8931c7df6c69b`](https://github.com/Rhymer-Lcy/civic-work-desk/commit/a0e0a4ce73e205823e3f6c0fa1d8931c7df6c69b) (Phase 5.1 sign-off) |
| Interface generation     | `ui-CNP0PG2u`                                                                                                                                                    |
| Data formats             | browser database schema 2, backup format 3                                                                                                                       |
| Administrator rights     | not required                                                                                                                                                     |
| Code signing             | none: the installer is unsigned                                                                                                                                  |

Optional check before installing (PowerShell, in the folder holding the download):

```powershell
Get-FileHash .\CivicWorkDesk-Windows-x64-0.2.0-rc.1-Setup.exe -Algorithm SHA256
```

The hash must equal the SHA-256 above, which is also the content of `CivicWorkDesk-Windows-x64-0.2.0-rc.1-Setup.exe.sha256`.

## 试用步骤

1. 双击安装包；
2. 按提示完成安装；
3. 从开始菜单或桌面打开“政务工作记录台”；
4. 如升级时提示仍有其他页面打开，请先保存并关闭这些页面，再进入新版本；
5. 如有异常，运行“收集诊断信息”，并将诊断文件（TXT）反馈给维护人员。

详细说明见随附的 `README-testing-zh-CN.txt`。

## Supported systems

- **Windows 11 x64**: the primary target.
- **Windows 10 22H2 x64** (build 19045): a legacy-compatibility target, **awaiting validation on a real
  machine**. The installer shows the Windows 10 end-of-support notice and does not block.
- **Not supported by this artifact:** Windows 7, Windows 8 and 8.1, other Windows 10 builds, Windows
  Server, 32-bit (x86) Windows and ARM64. The installer refuses them before writing any installation file.

This is **not** Windows certification.

## Security

The installer is **unsigned**, so Windows SmartScreen may show a warning. A SmartScreen warning by itself
neither proves nor disproves that a program is safe. Obtain the installer only from this release, compare
its SHA-256 if in doubt, and if still in doubt do not install it. **Do not disable Microsoft Defender,
SmartScreen or any other security software** to install or run it.

## What changed since RC3

- The application is the signed-off Phase 5.1 product, with a task hierarchy (2级 and 3级 sub-tasks),
  browser database schema 2 and backup format 3. Records from RC3 are upgraded in place when the new
  version first opens; in the acceptance runs every RC3 record survived, unchanged apart from the one
  field the new format adds.
- **Upgrading from RC3 goes through an explicit update check page**, `http://127.0.0.1:8765/api/civic/start`,
  before the new application opens. It asks the browser for the new version, refuses to switch while any
  other 政务工作记录台 page is still open, switches only when you click 进入新版本, and checks the result
  before entering. When it cannot confirm, it does not switch and offers 重试.
- **Going back to RC3 is intentionally refused** once this version has upgraded the records: RC3 does not
  know the links between tasks and sub-tasks and could damage them. There is no database downgrade.
- The browser check page is now at `http://127.0.0.1:8765/api/civic/platform`.

## Your records

- The application always runs at the fixed address **`http://127.0.0.1:8765/`**; the records belong to
  that address in your browser profile.
- **Uninstalling the program does not delete the records** kept in the browser's site data, and it does
  not delete exported files.
- **JSON backup** (设置 → 导出 JSON 备份) is the portable backup, and the one that can be restored. XLSX
  and DOCX exports are reports and cannot be restored. Export a JSON backup before upgrading.

## Known limitations

- An RC3 page that is still open can offer its own 应用更新. Pressing it switches versions without the
  check page and reloads the other RC3 pages, losing unsaved input there. Close every RC3 page before
  upgrading, as the installer asks.
- Accepted on one development workstation only. No colleague machine and no Windows 10 hardware has
  run it; managed-desktop policy, endpoint security software and 360 Browser are untested.
- The installer is unsigned (see Security).

## Measured

All from these installer bytes, all passing: RC3 upgrade 158 checks, installer experience 215, deployment 168, installed browser 81, release identity 66 and 70 (installed), provenance 13, and a 34-file privacy scan of the release with no finding.

Full record: [`docs/phase-6-windows-0.2.0.md`](https://github.com/Rhymer-Lcy/civic-work-desk/blob/windows-v0.2.0-rc.1/docs/phase-6-windows-0.2.0.md).

Licence: source is publicly readable; all rights reserved.
