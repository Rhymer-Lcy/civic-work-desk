import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RegisterSWOptions } from 'vite-plugin-pwa/types';
import { createUpdateCoordinator } from '@/app/pwa/service-worker-bridge';
import type { UpdateState } from '@/app/pwa/service-worker-bridge';

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
