# Browser-platform evidence — transcription

**Transcription, not the raw capture.** From the 360 Browser DevTools console on the physical target,
using the read-only snippet in the acceptance manual. See `PROVENANCE.md`.

This closes one of the two gaps carried since RC1.1. No application code was added to expose these
values — they are read once, by hand, in the console.

## Platform result

| Probe                          | Reported                                           |
| ------------------------------ | -------------------------------------------------- |
| `location.origin`              | `http://127.0.0.1:8765`                            |
| `'indexedDB' in window`        | `true`                                             |
| `'serviceWorker' in navigator` | `true`                                             |
| `'caches' in window`           | `true`                                             |
| `typeof crypto.subtle`         | `object`                                           |
| `typeof crypto.randomUUID`     | `function`                                         |
| service-worker registrations   | `1`                                                |
| Cache Storage                  | a Workbox precache exists for the canonical origin |

Every capability the application depends on is present, and the origin is exactly the canonical one —
the single most important line here, because a different origin would be a different, empty database.

`crypto.subtle` reporting `object` and `crypto.randomUUID` reporting `function` are both the expected
shapes; the backup checksum path needs the former and id generation the latter.

## Console errors observed — browser-extension noise, not an application failure

The console also contained duplicate-identifier errors originating from an **injected browser
extension**:

```
showcase/mcp_multimodal
```

Recorded, not erased. Classified as extension noise rather than a CivicWorkDesk failure on three
grounds, all of which are visible in the same evidence:

1. the errors originate in that extension's **content scripts**, not in any application bundle;
2. the application's own platform checks above all passed;
3. the tester reported application functionality as normal throughout.

What this classification does **not** claim: that the extension is harmless in general, or that a
future extension could not break the page. It says only that these particular errors were not produced
by this application. If a functional anomaly had accompanied them, the classification would not hold.

A clean-profile re-run would isolate it further and was not performed; that is a limitation of this
evidence, not a finding.
