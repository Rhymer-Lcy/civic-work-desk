# Phase-3 physical-target evidence — provenance

Read this before citing anything in this directory.

## What these files are, and what they are not

The physical UOS workstation produced two evidence files and one browser-console capture. **Their raw
bytes were not deposited into this repository.** What was returned into the engineering record is their
reported content.

Everything in this directory is therefore a **transcription**: the reported findings, restated in a
reviewable form, with the personal account name redacted. They are not the raw artefacts and must never
be described as such.

| This directory                                  | Corresponds to                                       | Kind              |
| ----------------------------------------------- | ---------------------------------------------------- | ----------------- |
| `FINAL-RESULTS-20260923-173115.transcribed.md`  | `civic-work-desk-final-results-20260923-173115.txt`  | transcription     |
| `POST-UNINSTALL-20260924-104544.transcribed.md` | `civic-work-desk-post-uninstall-20260924-104544.txt` | transcription     |
| `BROWSER-PLATFORM.transcribed.md`               | 360 Browser DevTools console output                  | transcription     |
| `MANUAL-OBSERVATIONS.md`                        | the tester's own observations                        | human observation |

### No hashes for the raw files

A provenance manifest would normally carry the SHA-256 of each returned file. These have none, because
the raw files are not present here — hashing a transcription and labelling it as the raw file's digest
would be worse than having no digest at all. The names and timestamps above are the identifiers.

If the raw files are later deposited, add their digests here and mark these transcriptions as derived.

## What the evidence is bound to

The evidence event is bound to an immutable artifact by digest, not to a commit:

```
civic-work-desk-uos20-loongarch64-2026.09.23-5.tar.gz
sha256  969a2a74bb3e893ef7e794729578383620f0d819e6ce74bd1e2cfb43f370e5bf

civic-work-desk-uos20-final-acceptance-2026.09.23-5.tar.gz
sha256  ac77a6e58eebb214acf16707d2a7e67a3aca2b98a36f8e55823822fee3680b30
```

Both digests were re-verified against the files on disk at closeout. Neither artifact was rebuilt.

## Sanitization applied

- the personal account name in paths is redacted to `<user>`, so `/home/<user>/.local/...`;
- no browser profile content, cookies, history or bookmarks;
- no business records — the acceptance procedure mandates synthetic data only;
- no contents of downloaded JSON backups or exported XLSX/DOCX;
- PASS/FAIL semantics are carried over unchanged. Nothing was reclassified, and nothing observed was
  removed, including the browser-extension console errors.

## Evidence classes

Three classes appear across the Phase-3 record, and they are not interchangeable:

| Class | What it is                                            | Where                                 |
| ----- | ----------------------------------------------------- | ------------------------------------- |
| **A** | RC1.1, measured on the physical workstation           | `docs/phase-3-stage-b-evidence.md` §A |
| **B** | development machine (Windows + WSL2)                  | `docs/phase-3-stage-b-evidence.md` §B |
| **C** | the final installed form, on the physical workstation | this directory                        |

Class B can never establish a claim about the target. The final compatibility claim rests on A and C.
