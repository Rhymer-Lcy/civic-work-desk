# Phase-3 handoff: UOS deployment

**This document implements nothing.** It records what is known about the target environment, what
Phase 2 deliberately did not do, and the questions Phase 3 must answer by observation rather than by
assumption.

## What Phase 2 produces

A static site. `npm run build` emits `dist/` — HTML, CSS, JavaScript, a web app manifest, a service
worker and icons. That directory is the entire deliverable. It contains no server, no runtime
dependency on Node, and no compiled binary.

```
development machine                    target workstation
───────────────────                    ──────────────────
Node 24 + npm 11                       a browser
Vite / TypeScript / Vitest      ──►    dist/  served over localhost
Playwright                             (mechanism chosen in Phase 3)
```

Node and npm are **build-time tools on the development machine only**. Nothing in `dist/` executes
them, references them, or needs them installed on the target.

`npm run preview` is a development convenience that happens to serve `dist/`. **It is not the
deployment mechanism** and must not be presented as one: it requires the whole Node toolchain, binds
a development server, and has no supervision or start-up integration.

## Known facts about the target

Supplied by the customer; none of it has been verified by running anything on the machine.

| | |
| --- | --- |
| Distribution | UnionTech UOS / 统信 UOS |
| Kernel | `4.19.0-loongson-3-desktop` (vendor kernel) |
| Architecture | `loongarch64` |
| Processor | Loongson 3A6000 |
| Memory | 16 GB |
| Network | fully offline |
| Users | single user, local workstation |

Two consequences follow directly and constrain everything else:

- **A vendor 4.19 kernel is not an upstream LoongArch environment.** Binaries built against modern
  upstream LoongArch toolchains cannot be assumed to run. Any Phase-3 option that involves shipping a
  compiled artifact has to be validated on the machine before it is chosen, not after.
- **Offline is absolute.** Nothing may be fetched at install time or at run time.

## Ruled out by the current architecture

Not open questions. These were excluded by the product architecture, and reopening any of them is a
change of architecture rather than a deployment decision:

- Electron, Tauri or any other native shell;
- a LoongArch installer (`.deb`, `.rpm`, AppImage);
- a native service or daemon;
- a cross-compiled helper binary;
- a backend, a database server, accounts or synchronisation;
- Node, npm, Docker, Java or any development toolchain on the target.

## What Phase 3 must decide — and must measure first

The only real question is **how `dist/` gets served to the browser on that machine**, because the
application needs a real origin: `file://` is not a secure context, so IndexedDB, service workers and
`crypto.subtle` are unavailable or restricted there. The answer will be some local static server, but
which one depends entirely on what the machine already has.

### Probe first (nothing can be decided without these)

| # | Question | How to answer it |
| --- | --- | --- |
| 1 | Exact UOS edition and release | `cat /etc/os-release`, `uname -a` |
| 2 | Which browser is installed, and its engine version | launch it; `about:version` or equivalent |
| 3 | Does that browser support `<dialog>`, `crypto.subtle`, IndexedDB in the intended origin? | a one-page capability probe served from the chosen origin — this is the single highest-value experiment in Phase 3 |
| 4 | Is Python 3 present, and which version? | `python3 -V` |
| 5 | Is BusyBox present (`busybox httpd`)? | `busybox --list \| grep httpd` |
| 6 | Any system HTTP server already installed (nginx, lighttpd, darkhttpd)? | `which nginx lighttpd darkhttpd` |
| 7 | Can the user bind a loopback port ≥ 1024, and is loopback traffic restricted by policy? | attempt a bind; check firewall rules |
| 8 | Does the user have permission to install packages, or write outside `$HOME`? | `id`, `sudo -n true`, try a write |
| 9 | How are desktop shortcuts and autostart handled in this desktop environment? | inspect `~/.local/share/applications`, `~/.config/autostart` |
| 10 | Organisation policy on installing software, and on browser policy files | ask; do not infer from what is technically possible |

### Only then, the options

Sketched so the probe results have something to select between. **No recommendation is made here**,
because every one of these depends on answers 4–8:

- a static server the distribution already ships (nginx / lighttpd), configured for one directory;
- `python3 -m http.server` behind a desktop launcher or autostart entry;
- `busybox httpd`, if present;
- a browser policy that opens the app on start-up, pointed at whichever of the above is chosen.

Each needs the same three things established: it starts without network access, it survives a reboot
in whatever way the user expects, and the origin it serves is a secure context for the browser in
question.

## What Phase 3 inherits from Phase 2

- `docs/browser-compatibility.md` — the required-capability list to probe against, and an explicit
  statement that no UOS browser version has been measured.
- A production build whose only runtime inputs are the files in `dist/`.
- An external-network assertion in the test suite, so "it works offline" is a tested property rather
  than an intention.

## What must not happen in Phase 3

- Declaring UOS compatibility without having run the application on the target machine.
- Choosing a serving mechanism before probing questions 4–8.
- Adding a runtime dependency on Node to make deployment easier.
- Treating `npm run preview` as the answer.
