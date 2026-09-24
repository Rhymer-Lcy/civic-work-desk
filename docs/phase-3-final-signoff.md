# Phase 3 — UOS Offline Deployment & Release Engineering: SIGNED OFF

**Phase 3 = SIGNED OFF.**

Authoritative closeout. Where any other document disagrees with this one about what was validated, this
one is right and the other is stale.

## 1. The tested release

```
civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz
sha256  969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf

civic-work-desk-uos20-final-acceptance-2026.09.23-5.tar.gz
sha256  ac77a6e58eebb214acf16707d2a7e67a3aca2b98a36f8e55823822fee3680b30
```

**These exact bytes are frozen.** Both digests were re-verified against the files on disk at closeout.
Neither artifact was rebuilt for this sign-off, and no `-6` exists. If either file is ever regenerated,
the new bytes are a different artifact and carry none of the evidence below — the evidence is bound to
the digest, not to the filename and not to a commit.

## 2. Target environment

- UOS Desktop 20 Professional
- loongarch64 · Loongson 3A6000 · 16 GB RAM
- kernel 4.19.0-loongson-3-desktop
- Deepin desktop
- 360 安全浏览器 13.4.1140.83 stable · Chromium 126.0.6478.251
- fully offline operating model

## 3. Evidence classes

| Class | What it is                                                  | What it can support                                |
| ----- | ----------------------------------------------------------- | -------------------------------------------------- |
| **A** | RC1.1, measured on the physical workstation                 | BusyBox serving this application **on the target** |
| **B** | development machine (Windows + WSL2, BusyBox 1.30.1 x86_64) | the **deployment logic**                           |
| **C** | the final installed form, on the physical workstation       | that Phase 3 is **done**                           |

Class B never establishes a claim about the target: same BusyBox applet version, different architecture
and build. The compatibility claim in §11 rests on A and C only. Detail: `docs/phase-3-stage-b-evidence.md`
(A and B) and `docs/phase-3-evidence/` (C).

## 4. A — RC1.1 physical-target evidence

Automated: port 8765 free; BusyBox httpd present and accepting the required options; `/` → `text/html`,
entry JS → `text/javascript`, entry CSS → `text/css`, `/sw.js` → `text/javascript`,
`/manifest.webmanifest` → `application/manifest+json`, `/deployment-health.json` → `application/json`;
`/assets/` directory listing refused with 404; three traversal probes contained, raw-path assertions
passed. This is the evidence that selected BusyBox as the production server.

Manual, at RC1.1: the workflow, backup/restore, exports and offline operation, plus `xdg-open` opening
360 Browser at the canonical origin. Full workstation reboot was recorded **N/A** at that point, because
it had not been performed.

## 5. B — Stage-B development-machine evidence

`lint:uos` 110 files · `test:uos` **138/138** against real BusyBox, real `/proc`, real signals ·
`test:uos:archive` **55/55** over the bytes of both delivered tars · rehearsal of the delivered `-5`
archives **63/63**, including a real `-4`→`-5` upgrade, rollback, two concurrent installers and a
same-ID repair · four mutants each caught by the assertion written for it.

Application gates at the sign-off commit: format, ESLint, typecheck, **330** Vitest, production build,
static security scan, **96** Chromium E2E, **21** Firefox/WebKit (+1 disclosed skip), **14** axe a11y,
npm audit — all PASS.

## 6. C — final installed-form physical evidence

From `civic-work-desk-final-results-20260923-173115.txt` (transcribed in
`docs/phase-3-evidence/`), collected **before** uninstall with the service running:

- UOS / loongarch64 target identity confirmed;
- installed `releaseId` `2026.09.23-5`;
- canonical origin `http://127.0.0.1:8765`;
- BusyBox production server; **Python not required; sudo not required**;
- `current` resolves to `releases/2026.09.23-5`;
- production `status` reports the local service running and healthy;
- served document root is the active release; health check identifies `2026.09.23-5`;
- repeated launches reuse a healthy server;
- stop/start lifecycle works;
- **port conflict refuses startup** rather than changing origin or killing the occupant, and the service
  recovers normally afterwards;
- desktop entry uses the expected absolute launcher and icon paths;
- all five user-level commands installed.

## 7. Browser-platform result

`location.origin` `http://127.0.0.1:8765` · IndexedDB available · Service Worker API available · Cache
Storage available · `typeof crypto.subtle` `object` · `typeof crypto.randomUUID` `function` ·
service-worker registrations **1** · a Workbox precache exists for the canonical origin.

The console also carried duplicate-identifier errors from an injected browser extension
(`showcase/mcp_multimodal`). Recorded, not erased, and classified as **extension console noise rather
than an application failure**: the errors originate in that extension's content scripts, the
application's own platform checks all passed, and functionality was reported normal. A clean-profile
re-run would isolate it further and was not performed.

## 8. Reboot observation — manual

**The workstation was physically rebooted and the application remained operational.**

This is a **tester observation**, not an automated persistence log. No more granular machine-readable
reboot record exists, and none is claimed. It closes the item that RC1.1 correctly recorded as N/A.

## 9. Functional, offline and uninstall results

Functional (manual, synthetic data): create/edit work record · add progress · create and link an honour ·
search/filter · ledger · report preview · canonical JSON backup · exact restore · XLSX export opening
locally · DOCX export opening locally. No application-use anomaly reported. Subjective performance: work
list smooth, ledger acceptable, report generation acceptable — qualitative judgements, no timings taken.

**Offline: the complete tested workflow works offline.**

Uninstall, from `civic-work-desk-post-uninstall-20260924-104544.txt`: program directory removed **PASS** ·
desktop/menu entry removed **PASS** · deployment log directory removed **PASS** · all five commands
removed **PASS** · Downloads preserved **PASS** · 360 browser profile preserved **PASS** —
**6 PASS / 0 FAIL, RESULT: PASS.** It also documents the intended behaviour that browser-resident site
data is not cleared, so reinstalling at the same origin restores the records.

## 10. Known non-blocking limitations and provenance notes

**Build-time metadata inside the frozen artifact.** The tested artifact carries

```
targetTested=NO
installedFormTargetValidated=NO
phase3Stage=Stage B.1
```

All three were **true when the immutable artifact was produced**, before physical validation existed.
They were deliberately **not** changed, because rebuilding to edit metadata would produce different
bytes that had never been tested — exactly the substitution this record exists to prevent. Physical
acceptance is an external evidence event bound to the artifact's SHA-256, not a field inside it.

`phase3Stage=Stage B.1` is additionally a **known non-blocking provenance discrepancy**: the engineering
process reached Stage B.2 before final validation, and the field was stamped at build time. It is a
metadata staleness, **not a runtime defect** — nothing reads it at run time.

Other limitations, stated rather than glossed:

- the extension console noise in §7 was not isolated with a clean browser profile;
- reboot persistence rests on a manual observation (§8);
- no performance figure was measured anywhere;
- Class-B evidence was produced on x86_64 BusyBox, not loongarch64;
- upgrade/rollback were rehearsed with delivered bytes on the development machine and exercised on the
  target only as far as the acceptance procedure covers.

## 11. Compatibility claim — exact wording

> CivicWorkDesk release `2026.09.23-5`
> (SHA-256 `969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`)
> was physically validated on UOS Desktop 20 Professional,
> loongarch64 / Loongson 3A6000,
> kernel 4.19.0-loongson-3-desktop,
> using 360 Browser 13.4.1140.83 / Chromium 126.0.6478.251.

**Not claimed:** generic Linux support · all UOS versions · all LoongArch systems · all 360 Browser
versions. The evidence covers this release on this target class, and widening it past that would be a
claim with nothing behind it.

## 12. Engineering findings preserved

Significant defects found and repaired during Phase 3 are kept on the record in
`docs/phase-3-stage-b-evidence.md` — they are release-engineering provenance, and all are **repaired**,
not current product defects:

BusyBox `wget -T` segfault in the health gate · the `mv` symlink-dereference defect in pointer
activation · the deployment-lint coverage hole that left RC1.1 unscanned · evidence collected after
uninstall · the PID-reuse window before SIGKILL · the stale launcher-lock design · the concurrent-installer
nested-release defect · the same-ID false-success repair defect · several acceptance-harness defects
(including a `nok()` that aborted the suite on a detail-less failure) · and one unreproduced E2E gate
failure, recorded as an unexplained observation rather than diagnosed.

## 13. Status

**Phase 3 — UOS Offline Deployment & Release Engineering: SIGNED OFF.**

No `-6` was created and `-5` was not rebuilt. Nothing in the application changed for this closeout.
