# Windows 10 22H2 x64 — legacy-compatibility plan

**Date:** 2026-09-29 (UTC+8). **Status:** plan only. No build, no installer change, no relaxed preflight
in Phase 5. Windows RC3 stays exactly as published.

## The field report, corrected

A colleague's machine was reported as "Win7 / 32-bit". The screenshots establish otherwise:
**Windows 10 Pro, version 22H2, OS build 19045.6466, 64-bit operating system on an x64 processor.**
RC3 refused it because RC3's declared policy is Windows 11 x64 only — not because of 32-bit or
Windows 7. Two gates enforce that policy today:

- the installer: `MinVersion=10.0.22000` in `deploy/windows/installer/civic-work-desk.iss`, which Inno
  Setup checks before anything else;
- the staged preflight: `civic-admin` reports `Windows 11 FAIL` below build 22000
  (`deploy/windows/src/cmd/civic-admin/main.go`).

**Out of scope, explicitly:** a Windows 7 package and an x86 (32-bit) package. Go 1.21 and later require
Windows 10 or Windows Server 2016 ([go.dev/doc/go1.21](https://go.dev/doc/go1.21),
[go.dev/wiki/MinimumRequirements](https://go.dev/wiki/MinimumRequirements)), and this repository pins
`go 1.27`; nothing here targets 32-bit Windows.

## What Windows 10's status actually is

Checked against Microsoft's own pages on 2026-09-28 (each opened; see the source list at the end):

- Windows 10 Home and Pro follow the **Modern Lifecycle Policy** and reached **end of support
  (retirement) on 2025-10-14**; 22H2 is the final version. The Modern policy has no mainstream/extended
  split, so "end of mainstream support" is the wrong phrase for these editions.
- After that date security updates reach only devices enrolled in **Extended Security Updates**. The
  consumer programme currently runs to **2027-10-12** (it was originally one year, to 2026-10-13, and
  was extended; the extension is reported by the press and stated on Microsoft's current ESU page).
  Commercial ESU runs for up to three years after end of support.
- **Microsoft Edge and the WebView2 Runtime** will keep receiving updates on Windows 10 22H2 "until at
  least October 2028", without ESU. Chrome's Windows 10 policy was not checked.
- The Go toolchain in use supports Windows 10, and no Go release has announced dropping it.

So nothing in the application's own stack forces Windows 11. RC3's Windows 11 requirement is a support
**policy**, not a technical constraint — which is exactly why it must not be relaxed on reasoning alone.

## Policy

1. **Windows 10 22H2 x64 is a _legacy-compatibility_ target class, field-validation only.** Supporting it
   is not an endorsement of running an out-of-support operating system. Documentation and the installer
   notice must say that the machine's own security depends on ESU enrolment (or an accepted risk owned by
   the machine's administrator), and that CivicWorkDesk does not change that.
2. **One Windows x64 product, one install path.** Windows 11 x64 stays primary; Windows 10 22H2 x64 is
   added as legacy compatibility to the same installer and the same payload. No fork, no second product,
   no second data format.
3. **Preflight stays as it is until a real Windows 10 target passes.** Relaxing `MinVersion` and the
   `civic-admin` gate is the _last_ step of the future phase, taken only after the evidence below exists.
4. **Browser floor is part of the target.** The UI runs in the user's browser against
   `http://127.0.0.1:8765/`; the supported pairing is Windows 10 22H2 + a current Edge (or Chrome, once its
   Windows 10 support statement has been read).

## Evidence required before the gate may move

Collected on at least one real Windows 10 22H2 x64 machine that is **not** the development workstation,
ideally the colleague's:

| area                          | evidence                                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| install / upgrade / uninstall | per-user install to the default and a custom path; upgrade from the previous release; rollback; uninstall         |
| launcher and server           | first launch, second launch while running, port 8765 busy, crash and restart                                      |
| browser                       | Edge version recorded; IndexedDB persistence across reboot; `navigator.storage.persist()` outcome; offline reload |
| data                          | create, back up, restore and merge; v1 → v2 schema migration from a Phase-4 database                              |
| managed policy                | Group Policy / Intune restrictions on per-user installs under `%LOCALAPPDATA%`, on loopback, on IndexedDB         |
| endpoint security             | Defender and any third-party endpoint product: installer, `civic-server.exe` listening on loopback, SmartScreen   |
| OS facts                      | `winver`, edition, ESU enrolment state, `CurrentBuild`, and the `civic-diag` report                               |

The diagnostic path (`civic-diag`) already reports the build number and redacts user paths; it is the
channel for that evidence.

## Future outcome, if the evidence holds

- `MinVersion` becomes `10.0.19045` (22H2) rather than the generic `10.0`, so older, unsupported Windows 10
  releases are still refused.
- `civic-admin` preflight reports `Windows 10 22H2 — legacy compatibility (PASS)` with the ESU notice,
  `Windows 11 — PASS`, and `FAIL` below 19045.
- The installer notice and README state the two target classes and what "legacy compatibility" means.
- The release record lists which target class each field result came from; a Windows 11 pass is never
  counted as Windows 10 evidence, or the reverse.

## Microsoft Store boundary

A Microsoft Store listing is not a way around any of this, and it is not Windows-11-only either: EXE/MSI
listings reach Windows 10 and 11 desktop devices. What gates a Store listing is **signing** (the installer
and every PE file inside it, with a certificate that chains to the Microsoft Trusted Root Program), a
versioned immutable HTTPS download URL, declared silent-install switches, an IARC age rating and a privacy
policy URL, which Store policy requires for every Win32 product. Publisher identity rules are in
[versioning-and-publisher.md](versioning-and-publisher.md).

## Sources (opened 2026-09-28)

- [Windows 10 Home and Pro lifecycle](https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro)
- [Modern Lifecycle Policy](https://learn.microsoft.com/en-us/lifecycle/policies/modern)
- [Windows release information](https://learn.microsoft.com/en-us/windows/release-health/release-information)
- [Windows 10 Extended Security Updates (consumer)](https://www.microsoft.com/en-us/windows/extended-security-updates)
- [Extended Security Updates for Windows 10 (commercial)](https://learn.microsoft.com/en-us/windows/whats-new/extended-security-updates)
- [Microsoft Edge supported operating systems](https://learn.microsoft.com/en-us/deployedge/microsoft-edge-supported-operating-systems)
- [Go 1.21 release notes](https://go.dev/doc/go1.21), [Go minimum requirements](https://go.dev/wiki/MinimumRequirements), [Go 1.27 release notes](https://go.dev/doc/go1.27)
- [MSI/EXE app package requirements](https://learn.microsoft.com/en-us/windows/apps/publish/publish-your-app/msi/app-package-requirements), [Microsoft Store Policies](https://learn.microsoft.com/en-us/windows/apps/publish/store-policies) (version 7.20, effective 2026-10-22)
- [Open a developer account](https://learn.microsoft.com/en-us/windows/apps/publish/partner-center/open-a-developer-account)

Not verified here: Chrome's Windows 10 support statement; the exact latest 22H2 build number; the exact
commercial ESU end date.
