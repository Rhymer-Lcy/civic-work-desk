import { describe, expect, it } from 'vitest';
import { inspectActivationSafety, interpretWindowReply } from '@/app/pwa/activation-safety';
import type { ActivationSafety, WaitingWorker } from '@/app/pwa/activation-safety';

/**
 * Reading the waiting worker's window answer (Phase 5.1, final correction).
 *
 * The decision table: `safe` only for a complete version-1 answer that names this page as the requester
 * and no other application window; `blocked` with the count otherwise; and `unknown`, never `safe`, for
 * everything else, including silence. The browser-level behaviour is tests/e2e/update-safety.spec.ts.
 */

const entry = (
  requester: boolean,
  kind: string,
  route: string | null = null,
): Record<string, unknown> => ({ requester, kind, route, visibility: 'visible', focused: false });

const reply = (windows: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'CIVIC_WINDOW_CLIENTS_RESULT',
  version: 1,
  worker: 'installed',
  windows,
  ...extra,
});

const SELF = entry(true, 'application', 'dashboard');

describe('interpretWindowReply', () => {
  it.each<[string, unknown, ActivationSafety]>([
    ['only this page', reply([SELF]), { status: 'safe' }],
    [
      'this page and utility pages',
      reply([
        SELF,
        entry(false, 'bootstrap'),
        entry(false, 'platform'),
        entry(false, 'service'),
        entry(false, 'outside-scope'),
      ]),
      { status: 'safe' },
    ],
    [
      'a worker that cannot report its own state',
      reply([SELF], { worker: 'unknown' }),
      { status: 'safe' },
    ],
    [
      'two other application windows',
      reply([
        SELF,
        entry(false, 'application', 'work'),
        entry(false, 'application'),
        entry(false, 'bootstrap'),
      ]),
      { status: 'blocked', otherApplicationWindows: 2 },
    ],
    [
      'another message',
      { type: 'SOMETHING_ELSE' },
      { status: 'unknown', reason: 'malformed-reply' },
    ],
    [
      'a newer protocol version',
      reply([SELF], { version: 2 }),
      { status: 'unknown', reason: 'unsupported-version' },
    ],
    [
      'an older protocol version',
      reply([SELF], { version: 0 }),
      { status: 'unknown', reason: 'unsupported-version' },
    ],
    [
      'a worker that is not waiting',
      reply([SELF], { worker: 'activated' }),
      { status: 'unknown', reason: 'worker-not-waiting' },
    ],
    [
      'windows that are not a list',
      reply('none'),
      { status: 'unknown', reason: 'malformed-reply' },
    ],
    [
      'an unknown window kind',
      reply([SELF, entry(false, 'tab')]),
      { status: 'unknown', reason: 'malformed-reply' },
    ],
    [
      'an unknown route',
      reply([entry(true, 'application', 'admin')]),
      { status: 'unknown', reason: 'malformed-reply' },
    ],
    [
      'an entry with a missing field',
      reply([SELF, { requester: false, kind: 'application' }]),
      { status: 'unknown', reason: 'malformed-reply' },
    ],
    [
      'no requester',
      reply([entry(false, 'application')]),
      { status: 'unknown', reason: 'requester-not-identified' },
    ],
    ['two requesters', reply([SELF, SELF]), { status: 'unknown', reason: 'malformed-reply' }],
    ['null', null, { status: 'unknown', reason: 'malformed-reply' }],
    ['a string', 'safe', { status: 'unknown', reason: 'malformed-reply' }],
  ])('%s', (_label, data, expected) => {
    expect(interpretWindowReply(data)).toEqual(expected);
  });
});

/** A fake waiting worker that answers on the transferred port, after `delayMs`, or never. */
function worker(
  answer: unknown,
  delayMs: number | 'never' = 0,
): WaitingWorker & { received: unknown[] } {
  const received: unknown[] = [];
  return {
    received,
    postMessage(message, transfer) {
      received.push(message);
      const port = transfer[0] as MessagePort;
      if (delayMs === 'never') {
        port.close();
        return;
      }
      setTimeout(() => {
        port.postMessage(answer);
        port.close();
      }, delayMs);
    },
  };
}

describe('inspectActivationSafety', () => {
  it('asks with exactly the version-1 request and one reply port', async () => {
    const target = worker(reply([SELF]));
    await expect(inspectActivationSafety(target)).resolves.toEqual({ status: 'safe' });
    expect(target.received).toEqual([{ type: 'CIVIC_WINDOW_CLIENTS', version: 1 }]);
  });

  it('with no waiting worker, the answer is unknown', async () => {
    await expect(inspectActivationSafety(null)).resolves.toEqual({
      status: 'unknown',
      reason: 'no-waiting-worker',
    });
  });

  it('a worker that never answers is unknown after the timeout, never safe', async () => {
    await expect(
      inspectActivationSafety(worker(null, 'never'), { timeoutMs: 20 }),
    ).resolves.toEqual({
      status: 'unknown',
      reason: 'no-answer',
    });
  });

  it('a safe answer that arrives after the timeout does not count', async () => {
    await expect(
      inspectActivationSafety(worker(reply([SELF]), 120), { timeoutMs: 20 }),
    ).resolves.toEqual({ status: 'unknown', reason: 'no-answer' });
  });

  it('a worker that cannot be messaged is unknown', async () => {
    const broken: WaitingWorker = {
      postMessage() {
        throw new Error('InvalidStateError');
      },
    };
    await expect(inspectActivationSafety(broken)).resolves.toEqual({
      status: 'unknown',
      reason: 'query-failed',
    });
  });
});
