import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
import { createUpdateCoordinator } from '@/app/pwa/service-worker-bridge';
import type { PwaController, UpdateState } from '@/app/pwa/service-worker-bridge';

/**
 * Update decisions across several open pages (Phase 5.1).
 *
 * The browser-level behaviour is proven end to end in tests/e2e/update-safety.spec.ts. These tests pin
 * the two things that suite cannot reach deterministically: the decision table itself, and the path
 * where a page is taken over before it ever showed the prompt, so the plugin never gave it a
 * `controlling` listener and only the page's own `controllerchange` listener can report it.
 */

function harness(): {
  states: UpdateState[];
  reload: ReturnType<typeof vi.fn>;
  coordinator: ReturnType<typeof createUpdateCoordinator>;
} {
  const states: UpdateState[] = [];
  const reload = vi.fn();
  const coordinator = createUpdateCoordinator((state) => states.push(state), reload);
  return { states, reload, coordinator };
}

describe('createUpdateCoordinator', () => {
  it('reloads the page that accepted, once, however many listeners report the take-over', () => {
    const { states, reload, coordinator } = harness();
    coordinator.needRefresh();
    coordinator.accept();
    coordinator.newerWorkerInControl();
    coordinator.newerWorkerInControl();
    expect(reload).toHaveBeenCalledTimes(1);
    expect(states).toEqual(['update-ready']);
  });

  it('never reloads a page that did not accept; it tells it instead, once', () => {
    const { states, reload, coordinator } = harness();
    coordinator.needRefresh();
    coordinator.newerWorkerInControl();
    coordinator.newerWorkerInControl();
    expect(reload).not.toHaveBeenCalled();
    expect(states).toEqual(['update-ready', 'activated-elsewhere']);
  });

  it('keeps the notice after a take-over: a later prompt or offline event does not replace it', () => {
    const { states, coordinator } = harness();
    coordinator.newerWorkerInControl();
    coordinator.needRefresh();
    coordinator.offlineReady();
    expect(states).toEqual(['activated-elsewhere']);
  });

  it('reloads a taken-over page only when its user asks, and only once', () => {
    const { reload, coordinator } = harness();
    coordinator.newerWorkerInControl();
    expect(reload).not.toHaveBeenCalled();
    coordinator.reload();
    coordinator.reload();
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe('registerServiceWorker wiring', () => {
  let captured: RegisterSWOptions | undefined;

  beforeEach(() => {
    vi.resetModules();
    captured = undefined;
    vi.doMock('virtual:pwa-register', () => ({
      registerSW: (options: RegisterSWOptions) => {
        captured = options;
        return () => Promise.resolve();
      },
    }));
  });

  async function register(controlled: boolean): Promise<{
    container: EventTarget;
    states: UpdateState[];
  }> {
    const container = Object.assign(new EventTarget(), {
      controller: controlled ? {} : null,
      getRegistrations: () => Promise.resolve([]),
    });
    vi.stubGlobal('navigator', { serviceWorker: container });
    const states: UpdateState[] = [];
    const bridge = await import('@/app/pwa/service-worker-bridge');
    bridge.registerServiceWorker({ onStateChange: (state) => states.push(state) });
    return { container, states };
  }

  it('supplies onNeedReload, so the plugin never reloads the page by itself', async () => {
    const { states } = await register(true);
    expect(captured?.onNeedReload).toBeTypeOf('function');
    captured?.onNeedReload?.();
    expect(states).toEqual(['activated-elsewhere']);
  });

  it('a controlled page taken over before any prompt is told through controllerchange', async () => {
    const { container, states } = await register(true);
    container.dispatchEvent(new Event('controllerchange'));
    expect(states).toEqual(['activated-elsewhere']);
  });

  it('a page that had no worker is not told anything when it gets its first one', async () => {
    const { container, states } = await register(false);
    container.dispatchEvent(new Event('controllerchange'));
    expect(states).toEqual([]);
  });
});

/**
 * `applyUpdate` activates only when the waiting worker reports no other application window (Phase 5.1,
 * final correction). `skipWaitingSent` counts calls of the plugin's update function, which is the only
 * way the product sends the skip-waiting message; every refused path must leave it at zero.
 */
describe('applyUpdate: activation only when no other application window is open', () => {
  let skipWaitingSent = 0;

  beforeEach(() => {
    vi.resetModules();
    skipWaitingSent = 0;
    vi.doMock('virtual:pwa-register', () => ({
      registerSW: () => () => {
        skipWaitingSent += 1;
        return Promise.resolve();
      },
    }));
  });

  const windowEntry = (requester: boolean, kind: string): Record<string, unknown> => ({
    requester,
    kind,
    route: null,
    visibility: 'visible',
    focused: false,
  });
  const answer = (others: number): Record<string, unknown> => ({
    type: 'CIVIC_WINDOW_CLIENTS_RESULT',
    version: 1,
    worker: 'installed',
    windows: [
      windowEntry(true, 'application'),
      ...Array.from({ length: others }, () => windowEntry(false, 'application')),
    ],
  });

  /** A waiting worker whose answers are taken, in order, from `answers`; `null` means no answer. */
  function waitingWorker(answers: (Record<string, unknown> | null)[]): {
    postMessage: (message: unknown, transfer: Transferable[]) => void;
    queries: () => number;
  } {
    let queries = 0;
    return {
      postMessage(_message, transfer) {
        const next = answers[Math.min(queries, answers.length - 1)] ?? null;
        queries += 1;
        const port = transfer[0] as MessagePort;
        if (next === null) {
          port.close();
          return;
        }
        setTimeout(() => {
          port.postMessage(next);
          port.close();
        }, 0);
      },
      queries: () => queries,
    };
  }

  async function register(registration: { waiting: unknown } | undefined): Promise<{
    pwa: PwaController;
    container: EventTarget;
    states: UpdateState[];
  }> {
    const container = Object.assign(new EventTarget(), {
      controller: {},
      getRegistration: () => Promise.resolve(registration),
      getRegistrations: () => Promise.resolve([]),
    });
    vi.stubGlobal('navigator', { serviceWorker: container });
    const states: UpdateState[] = [];
    const bridge = await import('@/app/pwa/service-worker-bridge');
    const pwa = bridge.registerServiceWorker({
      onStateChange: (state) => states.push(state),
      inspectionTimeoutMs: 30,
    });
    return { pwa, container, states };
  }

  it('alone: activates once, and a second press sends nothing again', async () => {
    const target = waitingWorker([answer(0)]);
    const { pwa } = await register({ waiting: target });
    await expect(pwa.applyUpdate()).resolves.toEqual({ status: 'safe' });
    expect(skipWaitingSent).toBe(1);
    await expect(pwa.applyUpdate()).resolves.toEqual({ status: 'safe' });
    expect(skipWaitingSent).toBe(1);
    expect(target.queries()).toBe(1);
  });

  it('another application window: refused, nothing sent; each retry asks again', async () => {
    const target = waitingWorker([answer(2), answer(1), answer(0)]);
    const { pwa } = await register({ waiting: target });
    await expect(pwa.applyUpdate()).resolves.toEqual({
      status: 'blocked',
      otherApplicationWindows: 2,
    });
    await expect(pwa.applyUpdate()).resolves.toEqual({
      status: 'blocked',
      otherApplicationWindows: 1,
    });
    expect(skipWaitingSent).toBe(0);
    await expect(pwa.applyUpdate()).resolves.toEqual({ status: 'safe' });
    expect(target.queries()).toBe(3);
    expect(skipWaitingSent).toBe(1);
  });

  it.each([
    ['no answer', [null]],
    ['a newer protocol version', [{ ...answer(0), version: 2 }]],
    [
      'a malformed answer',
      [{ type: 'CIVIC_WINDOW_CLIENTS_RESULT', version: 1, worker: 'installed' }],
    ],
  ])('%s: unknown, nothing sent', async (_label, answers) => {
    const { pwa } = await register({ waiting: waitingWorker(answers) });
    const result = await pwa.applyUpdate();
    expect(result.status).toBe('unknown');
    expect(skipWaitingSent).toBe(0);
  });

  it('no waiting worker, or no registration: unknown, nothing sent', async () => {
    for (const registration of [{ waiting: null }, undefined]) {
      vi.resetModules();
      const { pwa } = await register(registration);
      await expect(pwa.applyUpdate()).resolves.toEqual({
        status: 'unknown',
        reason: 'no-waiting-worker',
      });
    }
    expect(skipWaitingSent).toBe(0);
  });

  it('a different worker waiting by the time of the answer: unknown, nothing sent', async () => {
    const registration: { waiting: unknown } = { waiting: null };
    const first = waitingWorker([answer(0)]);
    registration.waiting = {
      postMessage(message: unknown, transfer: Transferable[]) {
        registration.waiting = waitingWorker([answer(0)]);
        first.postMessage(message, transfer);
      },
    };
    const { pwa } = await register(registration);
    await expect(pwa.applyUpdate()).resolves.toEqual({
      status: 'unknown',
      reason: 'waiting-worker-changed',
    });
    expect(skipWaitingSent).toBe(0);
  });

  it('concurrent presses share one question and send at most one message', async () => {
    const target = waitingWorker([answer(0)]);
    const { pwa } = await register({ waiting: target });
    const results = await Promise.all([pwa.applyUpdate(), pwa.applyUpdate(), pwa.applyUpdate()]);
    expect(results).toEqual([{ status: 'safe' }, { status: 'safe' }, { status: 'safe' }]);
    expect(target.queries()).toBe(1);
    expect(skipWaitingSent).toBe(1);
  });

  it('after a refusal, an activation made elsewhere is still reported, not reloaded into', async () => {
    const { pwa, container, states } = await register({ waiting: waitingWorker([answer(1)]) });
    await pwa.applyUpdate();
    container.dispatchEvent(new Event('controllerchange'));
    expect(states).toEqual(['activated-elsewhere']);
    expect(skipWaitingSent).toBe(0);
  });
});
