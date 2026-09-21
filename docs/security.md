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
style-src 'self' 'unsafe-inline';
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
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Resource-Policy: same-origin
Permissions-Policy: camera=(), microphone=(), geolocation=(), interest-cohort=()
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

### Why `'unsafe-inline'` appears for styles and nowhere else

`style-src` needs it because CSS modules and a handful of inline `style` attributes are emitted by
the static build, and a nonce cannot be attached to those without a server rendering the HTML per
request.

`script-src` does **not** have it, and `'unsafe-eval'` appears nowhere. Those are the directives
that matter for code execution, and an E2E test asserts both conditions against the built
`index.html` so a future change cannot quietly weaken them.

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
