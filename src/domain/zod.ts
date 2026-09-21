import { z } from 'zod';

/**
 * Zod, configured once for this application's Content-Security-Policy.
 *
 * Zod 4 compiles each schema into a specialised validator with `new Function` the first time it
 * parses. Under `script-src 'self'` — no `'unsafe-eval'` — the browser refuses that, Zod catches
 * the failure and falls back to its interpreted evaluator, so validation still works. What it does
 * *not* do is stay quiet: every load raised a `securitypolicyviolation` and logged a refusal.
 *
 * That was true of Phase 1 as well; nothing here caused it. It surfaced only once an E2E test
 * started listening for violations, which is the point of listening — a page that "works" can still
 * be fighting its own policy, and a real violation would have been indistinguishable from this
 * noise.
 *
 * `jitless` skips the compilation attempt entirely. The cost is the interpreted path, which this
 * application was already using; the benefit is an artifact that raises no violation under its own
 * policy, so any future violation means something.
 *
 * Both Zod consumers (`domain/validation.ts` and `services/backup/envelope.ts`) import `z` from
 * here rather than from `zod`, so the configuration cannot be bypassed by import order.
 */
z.config({ jitless: true });

export { z };
