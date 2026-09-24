# Final functional observations — MANUAL, physical target

**These are a person's observations, not captured tool output.** They are recorded as such wherever
cited, because the distinction matters: an automated log can be re-read and re-checked, an observation
cannot. See `PROVENANCE.md`.

Artifact under test: `civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz`,
sha256 `969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf`.
All data used was synthetic, as the acceptance procedure requires.

## Functional workflow — tester confirmed

- application functionality normal; no application-use anomaly reported
- create and edit a work record
- add progress to a record
- create an honour and link it to a work record
- search and filter
- ledger
- report preview
- canonical JSON backup
- exact restore
- XLSX export, and it opens locally
- DOCX export, and it opens locally

## Offline

The complete tested workflow works **offline**. This is the operating model the product is built for,
not a degraded mode.

## Subjective performance

| Area                | Reported   |
| ------------------- | ---------- |
| work list scrolling | smooth     |
| ledger scrolling    | acceptable |
| report generation   | acceptable |

Recorded as the qualitative judgements they are. No timing was measured, so no latency figure is
claimed anywhere in the Phase-3 record.

## Reboot persistence — manual observation

**The workstation was physically rebooted, and the application remained operational afterwards.**

Stated precisely, because this is the second of the two gaps carried since RC1.1 and it is easy to
overstate:

- this is a **tester observation**, not an automated persistence log;
- there is **no** per-step machine-readable record of the reboot, and none is claimed. No more granular
  log exists than this sentence;
- what it establishes is that after a power cycle the operator could start the application from the
  menu and use it. That is what the gap asked for;
- what it does not establish is a count of reboots, timings, or behaviour across repeated cycles.

RC1.1 recorded this item as **N/A** rather than PASS because it had not been performed. It is now
performed, and reported at the strength of the evidence that exists.
