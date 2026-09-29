/**
 * Runtime UI-generation check (Phase 5.1).
 *
 * The question: is the interface running in this page the generation the installed program expects?
 * After a program upgrade the service worker of the previous version keeps answering navigations from
 * its own precache until the browser finds and activates the new worker, so a page can run the old
 * interface while the server already serves the new one. That happened on 2026-09-29 with RC3 under the
 * Phase-6 candidate, and the server's own `deployment-health.json` said "new" throughout, because the
 * page fetched it from the network while its interface came from the old cache. So the answer must come
 * from the running code itself, not from a file.
 *
 * Model. `appGeneration` is `ui-` followed by the content hash the bundler assigned to the application's
 * entry chunk (`assets/index-<hash>.js`). The build writes it to `app-generation.json` for a deployment
 * server to read (vite.config.ts, `emitAppGeneration`); the running page derives the same value from
 * its own module URL, below. It is distinct from the product version (package.json), the database
 * schema version, the backup format version and a platform release id; see
 * docs/phase-5.1-runtime-update-safety.md for the table.
 *
 * Behaviour. The page asks the same-origin deployment endpoint `/api/civic/runtime` which generation it
 * expects. No answer, a 404, an error, a non-JSON answer (a single-page fallback serving index.html) or
 * no network all mean "unknown" and change nothing; only a well-formed answer naming a different
 * generation is a mismatch. A mismatch is reported to the caller, which shows a notice and asks the
 * browser to look for the newer worker. Nothing here reloads the page, clears a cache or touches
 * IndexedDB.
 */

export const RUNTIME_ENDPOINT = '/api/civic/runtime';
export const RUNTIME_SCHEMA = 'civic-runtime/1';

const GENERATION = /^ui-[A-Za-z0-9_-]{6,64}$/;
const ENTRY_CHUNK = /\/assets\/index-([A-Za-z0-9_-]{6,64})\.js$/;
const DEFAULT_TIMEOUT_MS = 5_000;

/** The generation named by an entry-chunk URL, or null for any other URL. */
export function generationFromEntryUrl(url: string): string | null {
  try {
    const match = ENTRY_CHUNK.exec(new URL(url).pathname);
    return match?.[1] === undefined ? null : `ui-${match[1]}`;
  } catch {
    return null;
  }
}

/**
 * The generation of the interface running in this page.
 *
 * This module is bundled into the entry chunk, so in a production build `import.meta.url` is that
 * chunk's own URL. Under the dev server or in a unit test it is a source path, which names no
 * generation, and the check stays silent.
 */
export function runningGeneration(): string | null {
  return generationFromEntryUrl(import.meta.url);
}

export type UnknownReason =
  'running-generation-unknown' | 'endpoint-absent' | 'endpoint-unavailable' | 'invalid-response';

export type GenerationCheck =
  | { readonly outcome: 'match'; readonly generation: string }
  | { readonly outcome: 'mismatch'; readonly running: string; readonly expected: string }
  | { readonly outcome: 'unknown'; readonly reason: UnknownReason };

export interface CheckOptions {
  /** Defaults to `runningGeneration()`. */
  readonly running?: string | null;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

function expectedGeneration(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  if (record['schema'] !== RUNTIME_SCHEMA) return null;
  const generation = record['appGeneration'];
  return typeof generation === 'string' && GENERATION.test(generation) ? generation : null;
}

export async function checkRuntimeGeneration(options: CheckOptions = {}): Promise<GenerationCheck> {
  const unknown = (reason: UnknownReason): GenerationCheck => ({ outcome: 'unknown', reason });
  const running = options.running === undefined ? runningGeneration() : options.running;
  if (running === null) return unknown('running-generation-unknown');

  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const abort = new AbortController();
  const timer = setTimeout(() => {
    abort.abort();
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    let response: Response;
    try {
      // A plain GET with no body and no credentials: the endpoint learns nothing from the page.
      response = await fetchImpl(RUNTIME_ENDPOINT, {
        method: 'GET',
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'error',
        headers: { Accept: 'application/json' },
        signal: abort.signal,
      });
    } catch {
      return unknown('endpoint-unavailable');
    }
    if (response.status === 404) return unknown('endpoint-absent');
    if (!response.ok) return unknown('endpoint-unavailable');
    const type = response.headers.get('content-type') ?? '';
    if (!type.toLowerCase().startsWith('application/json')) return unknown('invalid-response');
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return unknown('invalid-response');
    }
    const expected = expectedGeneration(body);
    if (expected === null) return unknown('invalid-response');
    return expected === running
      ? { outcome: 'match', generation: running }
      : { outcome: 'mismatch', running, expected };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check now, and again whenever the page becomes visible, which is when a user returns to a tab that
 * may have been open across a program upgrade. One check at a time; returns the cleanup.
 */
export function watchRuntimeGeneration(
  onResult: (check: GenerationCheck) => void,
  options: CheckOptions = {},
): () => void {
  let running = false;
  let stopped = false;
  const run = (): void => {
    if (running || stopped) return;
    running = true;
    void checkRuntimeGeneration(options)
      .then((check) => {
        if (!stopped) onResult(check);
      })
      .finally(() => {
        running = false;
      });
  };
  const onVisibility = (): void => {
    if (document.visibilityState === 'visible') run();
  };
  document.addEventListener('visibilitychange', onVisibility);
  run();
  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibility);
  };
}
