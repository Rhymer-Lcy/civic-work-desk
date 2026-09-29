import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  RUNTIME_ENDPOINT,
  checkRuntimeGeneration,
  generationFromEntryUrl,
  runningGeneration,
  watchRuntimeGeneration,
} from '@/app/pwa/runtime-generation';
import type { GenerationCheck } from '@/app/pwa/runtime-generation';

/**
 * The runtime-generation check without a browser (Phase 5.1).
 *
 * The end-to-end behaviour, including a stale interface kept alive by an older service worker, is in
 * tests/e2e/runtime-generation.spec.ts. Here: which answers count as a mismatch (only a well-formed one
 * naming another generation), that every other answer is "unknown" and silent, and that the request
 * sends nothing: a GET with no body, no credentials and no cache.
 */

const RUNNING = 'ui-DY8buzpf';

function answering(status: number, body: string, type = 'application/json'): typeof fetch {
  return vi.fn(() =>
    Promise.resolve(new Response(body, { status, headers: { 'Content-Type': type } })),
  );
}

const runtime = (appGeneration: string): string =>
  JSON.stringify({ schema: 'civic-runtime/1', appGeneration });

describe('generationFromEntryUrl', () => {
  it.each([
    ['http://127.0.0.1:8765/assets/index-DY8buzpf.js', 'ui-DY8buzpf'],
    ['http://127.0.0.1:8765/assets/index-Czjj00lG.js?v=1', 'ui-Czjj00lG'],
    ['http://127.0.0.1:5173/src/app/pwa/runtime-generation.ts', null],
    ['http://127.0.0.1:8765/assets/vendor-react-Bspm2hG5.js', null],
    ['file:///F:/repo/src/app/pwa/runtime-generation.ts', null],
    ['not a url', null],
  ])('%s -> %s', (url, expected) => {
    expect(generationFromEntryUrl(url)).toBe(expected);
  });

  it('names no generation outside a production build', () => {
    expect(runningGeneration()).toBeNull();
  });
});

describe('checkRuntimeGeneration', () => {
  it('reports a match without noise', async () => {
    const fetchImpl = answering(200, runtime(RUNNING));
    await expect(checkRuntimeGeneration({ running: RUNNING, fetchImpl })).resolves.toEqual({
      outcome: 'match',
      generation: RUNNING,
    });
  });

  it('reports a mismatch only for a well-formed answer naming another generation', async () => {
    const fetchImpl = answering(200, runtime('ui-NEWERGEN'));
    await expect(checkRuntimeGeneration({ running: RUNNING, fetchImpl })).resolves.toEqual({
      outcome: 'mismatch',
      running: RUNNING,
      expected: 'ui-NEWERGEN',
    });
  });

  it.each<[string, typeof fetch, GenerationCheck]>([
    [
      '404',
      answering(404, 'not found', 'text/plain'),
      { outcome: 'unknown', reason: 'endpoint-absent' },
    ],
    [
      '503',
      answering(503, 'x', 'text/plain'),
      { outcome: 'unknown', reason: 'endpoint-unavailable' },
    ],
    [
      'a network error',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
      { outcome: 'unknown', reason: 'endpoint-unavailable' },
    ],
    [
      'an HTML fallback page',
      answering(200, '<!doctype html><title>x</title>', 'text/html'),
      { outcome: 'unknown', reason: 'invalid-response' },
    ],
    ['malformed JSON', answering(200, '{'), { outcome: 'unknown', reason: 'invalid-response' }],
    [
      'another schema',
      answering(200, JSON.stringify({ schema: 'other/1', appGeneration: 'ui-NEWERGEN' })),
      { outcome: 'unknown', reason: 'invalid-response' },
    ],
    [
      'an ill-formed generation',
      answering(200, runtime('<script>')),
      { outcome: 'unknown', reason: 'invalid-response' },
    ],
    ['a JSON array', answering(200, '[]'), { outcome: 'unknown', reason: 'invalid-response' }],
  ])('treats %s as unknown, never as a mismatch', async (_label, fetchImpl, expected) => {
    await expect(checkRuntimeGeneration({ running: RUNNING, fetchImpl })).resolves.toEqual(
      expected,
    );
  });

  it('does not ask at all when the running generation is unknown', async () => {
    const fetchImpl = answering(200, runtime('ui-NEWERGEN'));
    await expect(checkRuntimeGeneration({ running: null, fetchImpl })).resolves.toEqual({
      outcome: 'unknown',
      reason: 'running-generation-unknown',
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends a body-less GET to the same-origin endpoint, without credentials or cache', async () => {
    const fetchImpl = answering(200, runtime(RUNNING));
    await checkRuntimeGeneration({ running: RUNNING, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe(RUNTIME_ENDPOINT);
    expect(RUNTIME_ENDPOINT.startsWith('/')).toBe(true);
    expect(init).toMatchObject({
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      redirect: 'error',
    });
    expect(init).not.toHaveProperty('body');
  });

  it('gives up after the timeout and reports unknown', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    ) as unknown as typeof fetch;
    await expect(
      checkRuntimeGeneration({ running: RUNNING, fetchImpl, timeoutMs: 20 }),
    ).resolves.toEqual({ outcome: 'unknown', reason: 'endpoint-unavailable' });
  });
});

describe('watchRuntimeGeneration', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('checks at once, again when the page becomes visible, one check at a time, and stops', async () => {
    let visibility: DocumentVisibilityState = 'visible';
    vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
    const pending: ((response: Response) => void)[] = [];
    const fetchImpl = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    ) as unknown as typeof fetch;
    const results: GenerationCheck[] = [];
    const stop = watchRuntimeGeneration((check) => results.push(check), {
      running: RUNNING,
      fetchImpl,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    // A second trigger while the first check is in flight starts nothing.
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    pending[0]?.(
      new Response(runtime(RUNNING), { headers: { 'Content-Type': 'application/json' } }),
    );
    await vi.waitFor(() => {
      expect(results).toEqual([{ outcome: 'match', generation: RUNNING }]);
    });

    // Hidden: no check. Visible again: a check.
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // After cleanup, nothing is reported or started.
    stop();
    pending[1]?.(
      new Response(runtime('ui-NEWERGEN'), { headers: { 'Content-Type': 'application/json' } }),
    );
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
  });
});
