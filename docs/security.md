# Security and privacy

## Trust boundary

There is no server. The application is static files; every record lives in the browser's IndexedDB
on the user's own device. The trust boundary is **the browser profile of the OS user account**.

```
┌─────────────────────────────────────────────────────────┐
│ OS user account                                         │
│  ┌───────────────────────────────────────────────────┐  │
│  │ Browser profile                                   │  │
│  │   IndexedDB: civic-work-desk   ← all records      │  │
│  │   localStorage: cwd.pref.*     ← UI prefs only    │  │
│  │   Cache API: application shell ← no user data     │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
        │                                    │
        │ user-initiated download            │ (nothing else leaves)
        ▼                                    ▼
   JSON backup / XLSX / DOCX            no network egress
```

## Threat model

### In scope

| Threat                                         | Mitigation                                                                                                                                                                                                                          |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Third-party code observing usage               | No third-party code at runtime. No analytics, no CDN, no remote font, no external API. Asserted by an E2E test that fails on any request leaving the origin, and by a static scan of source _and_ `dist/`.                          |
| Injection through imported data                | React escapes all rendered text. `innerHTML`, `dangerouslySetInnerHTML`, `eval` and `new Function` are blocked by ESLint and by `scripts/static-security-scan.mjs`. Every imported record passes a Zod schema before it is written. |
| Injection through user-defined names           | Category, group and option names are rendered as text. The legacy build interpolated them into `innerHTML` in four places.                                                                                                          |
| A malicious or corrupted backup file           | Parsed, schema-validated, checksum-verified and previewed before any write. A checksum mismatch or a counts mismatch **blocks** the import.                                                                                         |
| Silent data loss                               | Every mutation is its own IndexedDB transaction. A row that fails validation on read is reported in Settings, never silently repaired or dropped. Deletion is a soft delete with a recoverable trash.                               |
| Accidental destruction                         | Replace-mode restore, emptying the trash, and clearing all data each require typing a confirmation phrase. The confirm button is never the initially focused control.                                                               |
| Leaking the legacy dataset into the repository | `_private_reference/` is git-ignored, excluded from the build, and excluded from the review package by an allow-list. `verify-review-package.mjs` fails if any path under it — or any legacy record id — appears in an archive.     |

### Out of scope

State these plainly rather than implying protection that does not exist.

| Not protected against                                                 | Why                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anyone with access to the unlocked OS user account or browser profile | IndexedDB is readable by devtools and by any process that can read the profile directory. **Local browser storage is not a security control.** No client-side scheme changes this: a key the application can use is a key an attacker at the same privilege level can use. |
| Malware or a malicious browser extension                              | An extension with host permissions can read page memory and storage. Outside what a web application can defend against.                                                                                                                                                    |
| Disk-level theft                                                      | Use OS full-disk encryption (BitLocker, FileVault, LUKS). The application cannot substitute for it.                                                                                                                                                                        |
| Backup files after export                                             | A downloaded JSON backup is plaintext and contains everything. Protecting it is the user's responsibility — see below.                                                                                                                                                     |
| Shoulder surfing, printed output                                      | Procedural.                                                                                                                                                                                                                                                                |

## No encryption at rest, deliberately

Phase 1 does **not** encrypt IndexedDB, and this is a decision rather than an omission.

Client-side encryption in a single-user local application with no server has nowhere to put the key.
Derive it from a passphrase and the user must type it on every launch, or it gets stored beside the
data and protects nothing. Either way an attacker who already controls the browser profile can read
the key material or the decrypted state. What such a layer reliably produces is **a false sense of
protection** and **a new way to lose all your data** — a forgotten passphrase with no recovery path.

The honest controls are OS-level: full-disk encryption, a locked screen, a separate OS account.

If encrypted-at-rest storage is genuinely needed later, it should arrive as a deliberate design with
a stated threat model, a key-management story and a recovery path. It must not be improvised.

## Backup handling

The JSON backup is **plaintext** and contains every record, every progress note, and the contents of
the trash. Treat an exported backup exactly as sensitively as the records themselves:

- store it somewhere the source device's loss would not also destroy;
- do not email it or put it on a shared drive without considering who can read that location;
- the file carries a SHA-256 of its payload, so tampering is detectable on import — but the
  checksum is integrity, not confidentiality.

**What "backup succeeded" can honestly mean.** Browsers expose no API that confirms a user kept a
downloaded file. The application therefore claims only what it can observe: the file was built and
handed to the browser without error. The wording is 「已生成」, not 「已保存」, and Settings tells the
user to confirm the file in their downloads folder. The legacy build wrote its "last backup" marker
unconditionally on click, and did so for spreadsheet exports too.

## Content Security Policy

Delivered in `index.html` as a meta tag:

```
default-src 'self';
script-src 'self';
style-src 'self';
img-src 'self' data: blob:;
font-src 'self';
connect-src 'self';
worker-src 'self';
manifest-src 'self';
object-src 'none';
base-uri 'none';
form-action 'self';
frame-src 'none';
media-src 'none';
upgrade-insecure-requests
```

### Limits of a meta-tag CSP — and what a deployment must add

A policy in a `<meta>` tag is **weaker than the same policy in an HTTP header**, in three specific
ways:

1. **`frame-ancestors` is ignored in a meta tag.** Clickjacking protection therefore requires a
   response header. This is the most important gap.
2. **`report-uri` / `report-to` are ignored**, so violations cannot be collected. (Not a concern
   here — there is nowhere to report _to_ — but it means the policy cannot be monitored.)
3. **It applies only from the point the parser reaches it.** Anything before it is unprotected. Our
   meta tag is the first element after `<meta charset>`, which is as early as it can be.

A deployment should send these response headers:

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### No directive carries `'unsafe-inline'` or `'unsafe-eval'`

An earlier revision of this file allowed `'unsafe-inline'` for `style-src` and justified it like
this: "CSS modules and a handful of inline `style` attributes are emitted by the static build, and a
nonce cannot be attached to those". **That justification was wrong on both counts.** CSS modules
compile to a hashed class list in a linked stylesheet, which `'self'` already permits; and the
`<meta name="theme-color">` sometimes cited alongside it is not a style at all.

Measured against the built output: `dist/index.html` contains no inline `<style>` element and no
`style` attribute, and the application's CSS arrives as one linked stylesheet. So `style-src 'self'`
holds, and the directive was tightened to it.

Two JavaScript inline-style writes were replaced at the same time — but **not** because CSP required
it, and the distinction is worth stating because the opposite is a natural assumption:

| where                          | was                                       | now                                                                                                                        |
| ------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `components/common/Dialog.tsx` | `document.body.style.overflow = 'hidden'` | adds the class `dialog-open`, whose rule lives in `styles/globals.css`, reference-counted so nested dialogs share one lock |
| `services/download.ts`         | `anchor.style.display = 'none'`           | `anchor.hidden = true` — the UA stylesheet hides it, and a programmatic `click()` still fires                              |

**CSP's `style-src` does not govern CSSOM property writes.** This was mutation-tested rather than
assumed: with `style-src 'self'` in force, restoring `document.body.style.overflow = 'hidden'` and
rebuilding produced no violation of any kind. Those two lines were therefore never what kept
`'unsafe-inline'` in the policy. They were replaced because a class keeps presentation in the
stylesheet, because the resulting inline `style` attribute _would_ be governed by `style-src-attr`
if the policy is ever tightened that far, and because it makes "no element carries a `style`
attribute" a structural invariant a test can assert.

**The one thing the strict policy did break was real, and had been breaking silently since Phase 1.**
Zod 4 compiles each schema with `new Function` on first parse; `script-src 'self'` refuses that, Zod
catches the failure and falls back to its interpreted evaluator. Validation therefore always worked,
while every page load raised a `securitypolicyviolation` and logged a refusal that nobody was
watching. `src/domain/zod.ts` now sets `z.config({ jitless: true })` — Zod's documented switch for
environments that disallow `eval` — and both Zod consumers import `z` from there, so the setting
cannot be bypassed by import order. Runtime behaviour in the browser is unchanged: the interpreted
path is the one that was already running.

Four E2E assertions hold this together. The built `index.html` must contain `style-src 'self';` and
must not contain `unsafe-inline` anywhere in the policy. A rendering test then drives the real
application under the real policy — create a record, open a dialog, assert `<body>` carries no
`style` attribute, assert the stylesheet actually applied — and fails on a single reported
violation, using the specified `securitypolicyviolation` event rather than console-text matching.

That last test **proves it can fail**: after asserting zero violations it deliberately injects an
inline `<style>` element and fails if that goes unreported. Without it, a listener that never fires
would be indistinguishable from a policy with nothing to report — and the first version of this test
was exactly that, a check that could only pass.

**One deliberate exception, scoped to the dev server.** Vite injects CSS as inline `<style>`
elements for hot replacement, which `style-src 'self'` correctly blocks. `vite.config.ts` therefore
carries a plugin (`civic-relax-dev-style-csp`, `apply: 'serve'`) that adds `'unsafe-inline'` to the
served HTML during `npm run dev` and never during a build. The plugin throws if the directive it
expects is missing, so the shipped policy cannot drift away from it silently. `vite preview` serves
the built files, so the E2E suite always measures the strict policy.

## Source maps are not shipped

`vite.config.ts` sets `build.sourcemap: false`. Phase 1 set it to `true`, so `dist/` carried `.map`
files that reproduced the complete TypeScript source — every comment, every Chinese UI string, the
whole legacy-migration heuristic — and the bundles advertised them with `//# sourceMappingURL`. For
a local-first application with no error-reporting service consuming them, that is disclosure with no
operational benefit.

Verified by an E2E test: every `<script src>` in the built `index.html` is fetched and must contain
no `sourceMappingURL`, and `<name>.map` must not be served even when requested directly.

The cost is accepted rather than worked around: a stack trace from a production bundle is minified.
Reproduce the fault against `npm run dev`, where maps are always present.

## Service worker and the Cache API

The service worker precaches the **application shell only**: JavaScript, CSS, HTML, icons, manifest.
There is no `runtimeCaching` rule of any kind, so no response carrying user data can enter the Cache
API.

This is verified rather than asserted: an E2E test creates a record with an identifiable string,
waits for the worker to activate, then walks every cache entry looking for that string. It fails if
the string is found.

## Dependency policy

- Six runtime dependencies, each justified in `docs/dependencies.md`.
- Every version pinned exactly. No `^`, `~`, `latest` or `*`. `save-exact=true` in `.npmrc`.
- `package-lock.json` is committed; CI installs with `npm ci`.
- CI runs `npm audit --omit=dev --audit-level=high`, so the gate is on code that actually ships.
- No dependency is loaded from a CDN at runtime; everything is bundled.

### Accepted advisory

`npm audit` reports **2 moderate** findings, both from one chain:

```
exceljs@4.4.0 → uuid@8.3.2
GHSA-w5hq-g745-h8pq — "Missing buffer bounds check in v3/v5/v6 when buf is provided" (moderate)
```

**Not reachable in this application.** The advisory affects `uuid.v3`, `v5` and `v6` when a `buf`
argument is supplied. ExcelJS imports only `v4`:

```
node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js:1
  const {v4: uuidv4} = require('uuid');
```

and calls it with no arguments, in the conditional-formatting extension writer. No `v3`/`v5`/`v6`
call exists anywhere in the tree.

npm's suggested "fix" is `exceljs@3.4.0` — an older major — which is not a fix. The finding is
accepted and recorded here; it is below the `high` gate threshold, so CI does not fail on it. It
should be re-checked whenever ExcelJS releases a version that updates its `uuid` dependency.

## PII handling

Records may contain personal names, telephone numbers and descriptions of live government work.

- **Phone and contact values are strings, always**, and are never reformatted. A spreadsheet-derived
  value such as `82393933.0` is _reported_ as a data-quality warning during import, never silently
  rewritten — a silent edit to a contact number is exactly the kind of change nobody notices until
  they dial it.
- **Test fixtures are synthetic.** `tests/fixtures/legacy-backups.ts` reproduces the structural edge
  cases with placeholder names (甲/乙/丙) and documentation-block phone numbers. No real value was
  copied.
- **Nothing is logged.** There is no telemetry, no error reporting service, and no `console.log` of
  record content (`no-console` is an ESLint error, with `warn`/`error` allowed for genuine faults).
- **Generated documents contain no scripts and no remote references.** XLSX and DOCX are written
  from the domain types by ExcelJS and `docx`; neither embeds a macro, an external image or a link
  to another origin.

## Reporting

This is an internal tool with no public deployment. See `SECURITY.md` for how to report an issue.
