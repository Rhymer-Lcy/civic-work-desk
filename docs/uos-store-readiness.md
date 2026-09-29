# UOS application store — readiness plan

**Date:** 2026-09-29 (UTC+8). **Status:** plan only. The signed-off artifact
`civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz` (SHA-256
`969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`) is not rebuilt or modified, and no
`-6` is produced. Application source stays shared across platforms; store packaging is a later
release-engineering phase.

## Sources and how they were read

UnionTech's developer documentation lives on the developer platform (`uosdn.uniontech.com`; the old
`doc.chinauos.com` links answer HTTP 301 to it). The site renders client-side, so the article bodies were
read on 2026-09-28 through the JSON endpoint the pages themselves load — the same content the pages render.
The official documents relied on, with their last-modified dates:

| short name | document                                                                                                              | last modified |
| ---------- | --------------------------------------------------------------------------------------------------------------------- | ------------- |
| PACKAGING  | [应用打包规范](https://uosdn.uniontech.com/#document3?dirid=656ef27dbd766615b0b0300e&id=65702eaebd766615b0b0310d)     | 2026-06-16    |
| LISTING    | [应用上架指南](https://uosdn.uniontech.com/#document3?dirid=656ef276bd766615b0b0300c&id=657041ddbd766615b0b03145)     | 2026-05-14    |
| REVIEW     | [应用审核规范](https://uosdn.uniontech.com/#document3?dirid=656ef27dbd766615b0b0300e&id=65703321bd766615b0b0311d)     | 2023-12-06    |
| DEV-CERT   | [开发者认证指南](https://uosdn.uniontech.com/#document3?dirid=656ef276bd766615b0b0300c&id=657036f6bd766615b0b03132)   | 2023-12-06    |
| MAINT      | [应用管理维护指南](https://uosdn.uniontech.com/#document3?dirid=656ef276bd766615b0b0300c&id=65704362bd766615b0b03149) | 2023-12-06    |
| DEBUG-SIGN | [开发者调试签名](https://uosdn.uniontech.com/#document3?dirid=656ef276bd766615b0b0300c&id=657129b4bd766615b0b031a2)   | 2026-06-18    |

Also opened, and cited where used: the UnionTech FAQ on unsigned packages
([faq.uniontech.com/desktop/app/133f](https://faq.uniontech.com/desktop/app/133f), dated 2024-02-23), the
UOS **Home-edition** manual for 安全中心
([home.uniontech.com](https://home.uniontech.com/help/zh_CN/Home/deepin-defender.html); no Professional
equivalent was found), and — as a secondary, community source that UnionTech's own Linglong pages link to —
[areweloongyet.com](https://areweloongyet.com/docs/old-and-new-worlds/) for which UOS release is which
LoongArch world.

Where REVIEW (2023) and PACKAGING (2026) disagree, both readings are given and the plan satisfies both.

## Today's delivery is not a store package

The current UOS release is a `tar.gz` with an `install.sh` that installs per user, without `sudo`:

| what                       | where it goes today                                              |
| -------------------------- | ---------------------------------------------------------------- |
| program files, per version | `~/.local/share/civic-work-desk/` (side by side, for rollback)   |
| five commands              | `~/.local/bin/` (launch, status, stop, rollback, uninstall)      |
| menu entry                 | `~/.local/share/applications/civic-work-desk.desktop`            |
| logs                       | `~/.local/state/civic-work-desk/`                                |
| PID and runtime state      | `$XDG_RUNTIME_DIR/civic-work-desk/`, else under the state folder |
| business data              | the browser's IndexedDB — untouched by any of the above          |

The store excludes this route on several independent grounds:

- the packaging spec names deb as the binary format — “统信UOS应用商店支持deb格式的二进制软件包” (PACKAGING
  §5.1) — and the upload step validates architecture, package name and version from the package itself
  (LISTING §2.1.2);
- “必须使用应用商店提供的技术来进行打包和提交，不允许使用第三方安装器；应用必须使用应用商店分发机制进行更新，不允许使用其他更新机制。”
  (REVIEW §4.3(8));
- every installed file lives under `/opt/apps/<appid>/` (PACKAGING §2.1);
- uninstall goes through the system's right-click uninstall or the store, and an app may not add a menu
  entry such as “卸载XXX软件” (REVIEW §4.3(4)).

## Requirements, mapped to this product

| topic                | store requirement                                                                                                                                                                          | CivicWorkDesk today / implication                                                                                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| developer identity   | individual (PRC 身份证 real-name, about 7 working days) or enterprise (unified social credit code, about 5) (DEV-CERT); an enterprise enters its full company name as 开发者名称 (LISTING) | **unresolved** — `StorePublisherIdentity` stays empty until the account exists; see [versioning-and-publisher.md](versioning-and-publisher.md)                                            |
| package identifier   | reverse-domain, lowercase, equal to the deb `Package`, under a domain you control (PACKAGING §1)                                                                                           | needs an owned domain; `civic-work-desk` is a product id, not an appid                                                                                                                    |
| format and layout    | deb; `/opt/apps/<appid>/` with `entries/`, `files/` and a JSON `info` (PACKAGING §2–3)                                                                                                     | program files move from the per-user versioned folders into one root-owned `files/`; installed by the package manager, not by a script                                                    |
| version              | `info.version` four numeric parts `MAJOR.MINOR.PATCH.BUILD`, equal to the deb version (PACKAGING §3.3)                                                                                     | derive from the product version, e.g. `0.2.0.<build>`; never the date-based release id                                                                                                    |
| architecture         | label `loongarch64` for 3A5000, 3B5000 and newer (PACKAGING §3.3)                                                                                                                          | UOS 20 LoongArch is the old-world ABI (secondary source above), which that label covers — the current target                                                                              |
| desktop entry, icons | one `.desktop` under `entries/applications`, UTF-8, `Type=Application`; icons under `entries/icons/hicolor/...`, SVG recommended, PNG 16–512 (PACKAGING §3.1)                              | the single existing entry (`Categories=Office;ProjectManagement;`) and the icon family move into `entries/`                                                                               |
| privileges, files    | normal-user privileges only; no suid or capabilities; files `root:root` and not group- or other-writable; no system services (REVIEW security table; PACKAGING §3.3)                       | the loopback server already runs as the user, started by the launcher and never as a service — keep it that way                                                                           |
| user data            | no direct writes into `$HOME`; app data under `$XDG_DATA_HOME`, `$XDG_CONFIG_HOME` or `$XDG_CACHE_HOME`, per appid (PACKAGING §4)                                                          | logs in `~/.local/state` (`XDG_STATE_HOME`, not one of the three listed) move to a listed directory; the PID file in `$XDG_RUNTIME_DIR` is outside `$HOME` and not addressed — ask        |
| maintainer scripts   | REVIEW (2023) forbids `postinst`/`prerm`/…; PACKAGING (2026) tolerates them only for the app's own directory, with a mandatory `shellcheck`                                                | **ship none** — satisfies both readings                                                                                                                                                   |
| updates, uninstall   | only through the store; no self-update; no forced autostart (REVIEW §4.3)                                                                                                                  | the product has no updater. The rollback and uninstall commands and the side-by-side versions have no place in a store package: the store replaces versions and the system uninstalls     |
| network              | no network permission exists in `info.permissions` (PACKAGING §3.3); users set 联网控制 per app in 安全中心 (Home-edition manual)                                                          | whether 联网控制 set to “禁止” also blocks a **loopback** listener is unverified — test on the target                                                                                     |
| privacy              | a privacy policy is explicitly required only for antivirus and security software (REVIEW §7); no collection without authorisation                                                          | still provide a short, accurate statement (offline, no account, no telemetry); nothing in it may be invented                                                                              |
| listing material     | 3–6 same-size, distinct screenshots, landscape 3:2 (1050×700 to 1920×1280), each at most 2 MB; name ≤ 60 characters, one-line intro ≤ 100, description ≤ 1000 (LISTING, REVIEW)            | the review captures are 16:9 (1366×768, 1920×1080, 2560×1440) or 16:10 (1440×900); none is 3:2, so store captures are made separately, from synthetic data                                |
| signing              | UnionTech signs inside the review pipeline (MAINT §2.4 names an “应用签名” stage); developers sign locally only for testing (DEBUG-SIGN)                                                   | on 专业版 an uncertified package prompts “无有效的数字签名”, and the FAQ's remedies include getting it from the store; the store route therefore removes the dependence on developer mode |
| content              | “应用不得是简单打包的网站页面或套用模板、内容聚合或罗列链接” (REVIEW §5.1(1))                                                                                                              | **the main product risk** — see below                                                                                                                                                     |

**Linglong (如意玲珑).** The Linglong community's contribution page and deepin's store guide say Linglong
packages can be submitted through the same developer platform, but the UOS store's own packaging spec
(2026-06-16) names deb only. UnionTech's deb-to-Linglong converter supports only packages that already
conform to the store packaging spec, so a correct `/opt/apps` deb is the first step on either route.

## The architecture question to settle first

CivicWorkDesk's UI is a local web application served by its own loopback server and shown in the system
browser. REVIEW §5.1(1) rejects “简单打包的网站页面” (simply packaged web pages). An offline application
with its own data, its own server and no remote site is materially different from a web shortcut, but no
official text addresses this architecture, and a reviewer decides. Before any packaging work, ask the
store (`uosappstore@uniontech.com`):

1. Is an app whose UI is served from a loopback HTTP server into the system browser acceptable under
   REVIEW §5.1(1)?
2. Does 安全中心 联网控制 set to “禁止” for the app also block its loopback listener?
3. Does the UOS 20 专业版 store accept Linglong uploads, or deb only?
4. Are maintainer scripts that touch only `/opt/apps/<appid>` accepted?
5. What name is displayed as publisher for an individual developer?
6. How are new-world LoongArch (UOS V25, `loong64`) packages labelled in the upload form?
7. Is there a downloadable pre-submission checker equivalent to the store's 包格式检测?

If the answer to (1) is no, the store route needs an embedded web view instead of the system browser —
a different platform project, not a packaging change.

## Plan, in order

1. **Identity.** Decide individual or enterprise with the actual owner; complete developer certification;
   choose an appid under a domain that owner controls. Record it in `product-identity.json` only then.
2. **Architecture confirmation** from the store (questions above).
3. **Packaging script** that produces `<appid>_<A.B.C.D>_loongarch64.deb` from the same `dist/` and server
   build the tarball uses: `/opt/apps/<appid>/{info, entries/applications, entries/icons, files/}`, no
   maintainer scripts, all files `root:root` and not writable by group or others. The tarball route and
   its scripts stay as they are for machines outside the store.
4. **Runtime paths.** Logs move to a store-listed XDG directory; nothing is written under `/opt`.
5. **Package checks** before upload: `dpkg-deb --info` and `--contents`, an owner and mode audit,
   desktop-file validation, `shellcheck` if any script ever exists, and the store's own checks after
   upload.
6. **Physical validation on the UOS 20 loongarch64 target**: install from the signed store package, first
   launch, loopback behaviour under each 联网控制 setting, reboot persistence of browser data, uninstall,
   the v1 → v2 data migration on a machine that ran `-5`, and moving from a tarball install to the store
   package without losing browser data.
7. **Listing material**: 3:2 screenshots from synthetic data only, name and descriptions within limits,
   the offline / no-account / no-telemetry statement.

Out of scope for this plan: an enterprise intranet store (统信企业级应用商店), which a customer operates
with its own signing — relevant if target machines cannot reach the public store, and to be planned with
that customer.
