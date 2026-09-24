# UOS — next maintenance release backlog

**Nothing in this document has been done.** It is a list for the next UOS maintenance release, written
while the Windows RC2 work was fresh so the reasoning is not lost.

## Why none of it was done now

The signed-off artifact `civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz`
(SHA-256 `969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`) is **frozen**, and
`deploy/uos/` is the source it was built from. Editing that source without producing a release would
leave the tree and the shipped bytes disagreeing, with nothing to reconcile them — the stale-companion
problem, deliberately not created.

So the Windows RC2 copy rules were applied to the Windows surface only, and the UOS occurrences are
pinned at their exact current counts by `npm run audit:copy`. They cannot grow silently: a new one fails
the audit, and so does removing one, which is what forces these pins to be updated deliberately when the
work below actually happens.

## A. User-visible Chinese copy normalisation

Apply [copy-style-zh-CN.md](copy-style-zh-CN.md) to `deploy/uos/install.sh`,
`deploy/uos/runtime/*.sh`, `deploy/uos/README.md`, `deploy/uos/acceptance/*` and `docs/uos-*.md`.

Pinned counts as of this writing:

| Surface                         | Retired wording                                                 |
| ------------------------------- | --------------------------------------------------------------- |
| `deploy/uos/`                   | `规范地址` ×3, `部署集成` ×6, `再点一次` ×2, `「` ×56, `」` ×56 |
| `docs/uos-deployment.md`        | `规范地址` ×1, `「」` ×16 pairs                                 |
| `docs/uos-release-process.md`   | `规范地址` ×3, `「」` ×4 pairs                                  |
| `docs/uos-upgrade-recovery.md`  | `规范地址` ×1, `「」` ×12 pairs                                 |
| `docs/uos-final-acceptance.md`  | `「」` ×8 pairs                                                 |
| `docs/uos-target-acceptance.md` | `「」` ×2 pairs                                                 |

Substitutions: `规范地址` → `固定访问地址`; `部署集成` → `安装项`; `发布完整性` → `程序完整性`;
`「」` → `“”`; the safe-process sentence → `程序不会强行结束无法确认归属的进程。`

Note that `docs/uos-*.md` could in principle be normalised without touching the frozen payload, since
they are repository documents rather than shipped files. They are deferred with the rest so that the
terminology changes as one coherent set rather than leaving the documents and the scripts describing the
same thing with two different words.

## B. Desktop shortcut for 政务工作记录台

Windows RC2 gained an optional desktop shortcut, checked by default on a first install. UOS has no
equivalent. Offer one on the same terms: opt-out, per-user, removed on uninstall.

## C. Use `xdg-user-dir DESKTOP`, never `~/Desktop`

The desktop directory is localised. On a Chinese-locale UOS install it is typically `~/桌面`, so writing
to `~/Desktop` creates a folder the user never looks at and the shortcut appears to have failed silently.
`xdg-user-dir DESKTOP` is the supported way to ask, with `~/Desktop` only as a last-resort fallback when
`xdg-user-dir` is absent.

This applies to the diagnostic-report location as well as to the shortcut.

## D. Icon reference in the `.desktop` file

The current `civic-work-desk.desktop` has no usable `Icon=`. Install the PNG set (the same artwork the
Windows `.ico` is drawn from) under `~/.local/share/icons/hicolor/<size>/apps/` and reference it by
name, not by absolute path, so the icon survives the installation directory changing.

## E. Executable / trusted `.desktop` behaviour on Deepin and UOS

**Do not assume `chmod +x` plus a copy into `~/.local/share/applications/` is sufficient.** Deepin's file
manager applies its own trust rules to desktop entries, and behaviour differs between a launcher entry, a
desktop file placed on the desktop, and one in the applications directory. Recent Deepin versions have
shown a "this file is not trusted" prompt, or silently refused to launch, for entries that pass every
check a script can make.

The mechanism must be **measured on the real target**, not inferred from freedesktop.org. Until it is,
no claim about the desktop shortcut working on UOS may be made.

## F. Physical validation before any claim

Items B–E are all claims about a desktop environment's behaviour. None may be reported as working until
they have run on the physical UOS workstation — the same standard Phase 3 was held to, where the
installed form was only claimed after it ran on the target.

## Not in scope

- Rebuilding or modifying the frozen `-5` artifact.
- Creating a `-6` release as part of the Windows work.
- Applying Windows RC2's installer changes (custom path, desktop task, Start Menu grouping) to UOS
  without designing their UOS equivalents first.
