# Security

## Scope

CivicWorkDesk is a client-only application with no server, no accounts and no network calls. The
full threat model — including what it deliberately does **not** protect against — is in
[`docs/security.md`](docs/security.md). Read that before reporting; several "issues" are documented
design decisions.

In particular:

- **Local browser storage is not a security control.** Anyone with access to the unlocked OS user
  account or browser profile can read the records. This is stated, not hidden.
- **There is no encryption at rest**, deliberately. A client-side scheme has nowhere to put the key
  and would create a false sense of protection plus a new way to lose data. The reasoning is in
  `docs/security.md`.
- **Exported JSON backups are plaintext** and contain everything, including the trash.

## Reporting

This is an internal tool with no public deployment. Report to the maintainer of this repository
privately — do not open a public issue for anything exploitable.

Please include:

- what you did, and what happened;
- browser and version;
- whether data is disclosed, altered, or destroyed;
- a minimal reproduction, using **synthetic data only** (never attach real records).

## What is in scope

- Injection through imported backup files or user-defined names
- Data loss or corruption from a normal workflow
- A network request to any origin other than the application's own
- Records, backups or generated reports reaching the Cache API
- A destructive action completing without its confirmation
- A CSP weakness in the built output

## What is not in scope

- Reading data with access to the unlocked OS account or browser profile
- Malicious browser extensions
- Disk theft without full-disk encryption
- Handling of a backup file after the user has exported it
- Findings that require modifying the application's own source

## Dependencies

`npm audit --omit=dev --audit-level=high` runs in CI, so the gate is on code that actually ships.
One moderate advisory is accepted with documented evidence of non-reachability; see
`docs/security.md` and `docs/dependencies.md`.

## Handling the legacy source

`_private_reference/work-record-console.original.html` contains real personal data. It is excluded
from Git, from builds and from every review package, and `scripts/verify-review-package.mjs` fails
if any path under that directory — or any legacy record id — appears in an archive.

Never copy values out of it into fixtures, tests, documentation or commits.
