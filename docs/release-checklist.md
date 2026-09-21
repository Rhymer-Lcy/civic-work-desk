# Release checklist

Phase 1 produces a review package, not a deployment. This checklist covers both: the gates that must
pass before packaging, and what a real deployment would additionally require.

## Before packaging

### Code

- [ ] `npm ci` installs cleanly from the committed lockfile
- [ ] `node scripts/generate-css-module-types.mjs --check` reports every declaration current
- [ ] `npm run format:check` passes
- [ ] `npm run lint` passes with `--max-warnings=0`
- [ ] `npm run typecheck` passes for both TypeScript projects
- [ ] No `any`, `@ts-ignore`, or blanket ESLint disable was added without a written reason
- [ ] No source file exceeds the 400-line lint ceiling without justification

### Tests

- [ ] `npm run test:unit` — all pass
- [ ] `npm run test:e2e` — all mandatory flows pass
- [ ] `npm run test:a11y` — no unexplained axe violation
- [ ] The offline flow passes: install → create → offline → reload → read → write
- [ ] The external-network assertion passes across every route, including both lazy export chunks
- [ ] No test was skipped, `.only`'d, or loosened to make the run green

### Security and privacy

- [ ] `npm run scan:static` reports zero findings, with `dist/` included
- [ ] `npm audit --omit=dev --audit-level=high` reports nothing, or the exception is documented in
      `docs/security.md` with evidence of non-reachability
- [ ] `git status` is clean and `git ls-files` contains nothing from `_private_reference/`
- [ ] `dist/` contains no legacy record id and no personal data
- [ ] CSP in the built `index.html` still lacks `unsafe-eval` and inline scripts

### Data integrity

- [ ] A JSON backup round-trips to a byte-identical store
- [ ] A legacy backup imports with its warnings shown, and no value silently rewritten
- [ ] A tampered backup is refused
- [ ] Replace mode and trash-emptying both still require a typed phrase

### Build

- [ ] `npm run build` succeeds
- [ ] Initial JavaScript is within the 250 KiB gzip budget
- [ ] Export libraries are in lazy chunks, not the initial payload
- [ ] `dist/manifest.webmanifest` and every icon it names are present
- [ ] `dist/sw.js` exists and precaches the shell only

### Documentation

- [ ] `docs/qa-plan.md` results match this run, including anything that failed
- [ ] `CHANGELOG.md` updated
- [ ] Open items recorded honestly — no gate reported as passing that was not run

## Packaging

- [ ] `npm run review:package` — gates run and their real output captured
- [ ] `npm run review:verify` — all checks pass against the produced archive
- [ ] The ZIP and its `.sha256` are both in `_review_packages/`
- [ ] `review/VERIFY_LOG.txt` contains real command output, not a claim

## Additional, for an actual deployment

Not part of Phase 1. Recorded so it is not rediscovered later.

### Hosting

- [ ] Served over HTTPS (or loopback). `file://` is unsupported — see ADR 0001.
- [ ] The security response headers in `docs/security.md` are configured, especially
      `frame-ancestors` (a meta-tag CSP cannot set it)
- [ ] `sw.js` served with `Cache-Control: no-cache` so updates are discovered
- [ ] Hashed assets served with a long `max-age` and `immutable`
- [ ] `index.html` served with `no-cache`
- [ ] Correct MIME type for `.webmanifest`

### Verification after deploy

- [ ] Application loads and seeds on a clean profile
- [ ] Install prompt appears in Chromium; the browser-menu route works in Firefox/Safari
- [ ] Offline reload works after the first visit
- [ ] Devtools → Network shows no third-party request
- [ ] A backup downloads, and re-imports on a different machine
- [ ] XLSX opens in Excel/WPS with typed date cells
- [ ] DOCX opens in Word/WPS with intact tables

### Operational

- [ ] Users told that JSON backup is the only restorable format, and XLSX/DOCX are reports
- [ ] Users told where backups should be stored, and that they are plaintext
- [ ] A migration path from the legacy file is communicated (`docs/migration.md`)
- [ ] Someone owns re-running `npm audit` on a schedule

## Never

- [ ] Do not commit anything from `_private_reference/`
- [ ] Do not weaken a gate to make a run green — fix the cause or document the exception
- [ ] Do not add a runtime dependency that makes a network request
- [ ] Do not report a gate as passing that was not executed
