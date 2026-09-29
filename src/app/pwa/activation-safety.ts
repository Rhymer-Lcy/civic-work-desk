/**
 * May the waiting service worker be activated from this page? (Phase 5.1, final correction.)
 *
 * Activating a waiting worker puts it in control of every open page of the origin at once. Phase 5.1
 * stopped the other pages from reloading, which keeps their unsaved input, but it left them running the
 * previous generation's code next to the new one. A later generation may migrate the database; an older
 * page must not stay able to write under the previous schema's assumptions. So the product no longer
 * activates an update while any other application window is open.
 *
 * The question is answered by the waiting worker itself, over the reviewed window-awareness protocol
 * (`public/sw-client-awareness.js`, `CIVIC_WINDOW_CLIENTS` version 1). This module only asks and reads
 * the answer: it does not classify windows, it counts the ones the worker reported as `application`
 * that are not the requester. Everything that is not a complete, well-formed version-1 answer from a
 * waiting worker is `unknown`, and `unknown` is never treated as "no other window".
 */

const REQUEST_TYPE = 'CIVIC_WINDOW_CLIENTS';
const RESULT_TYPE = 'CIVIC_WINDOW_CLIENTS_RESULT';
const PROTOCOL_VERSION = 1;
const KINDS: ReadonlySet<unknown> = new Set([
  'application',
  'bootstrap',
  'platform',
  'service',
  'outside-scope',
]);
const ROUTES: ReadonlySet<unknown> = new Set([
  'dashboard',
  'work',
  'honors',
  'ledger',
  'reports',
  'settings',
]);
const VISIBILITY: ReadonlySet<unknown> = new Set(['visible', 'hidden']);
/*
 * The worker's own lifecycle state. `installed` is what a waiting worker reports; `unknown` is what the
 * protocol reports where the browser does not expose `ServiceWorkerGlobalScope.serviceWorker`, and the
 * answer still came from the waiting worker because the request was posted to it.
 */
const WAITING_STATES: ReadonlySet<unknown> = new Set(['installed', 'unknown']);

export const DEFAULT_INSPECTION_TIMEOUT_MS = 3_000;

export type UnknownActivationReason =
  | 'no-waiting-worker'
  | 'query-failed'
  | 'no-answer'
  | 'unsupported-version'
  | 'malformed-reply'
  | 'worker-not-waiting'
  | 'requester-not-identified'
  | 'waiting-worker-changed';

export type ActivationSafety =
  | { readonly status: 'safe' }
  | { readonly status: 'blocked'; readonly otherApplicationWindows: number }
  | { readonly status: 'unknown'; readonly reason: UnknownActivationReason };

/** The part of a waiting `ServiceWorker` this module uses; tests supply a fake. */
export interface WaitingWorker {
  postMessage(message: unknown, transfer: Transferable[]): void;
}

const unknown = (reason: UnknownActivationReason): ActivationSafety => ({
  status: 'unknown',
  reason,
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isWindowEntry(value: unknown): value is { requester: boolean; kind: string } {
  if (!isRecord(value)) return false;
  return (
    typeof value['requester'] === 'boolean' &&
    KINDS.has(value['kind']) &&
    (value['route'] === null || ROUTES.has(value['route'])) &&
    VISIBILITY.has(value['visibility']) &&
    typeof value['focused'] === 'boolean'
  );
}

/** Read one reply of the window-awareness protocol. Anything short of a complete answer is unknown. */
export function interpretWindowReply(data: unknown): ActivationSafety {
  if (!isRecord(data) || data['type'] !== RESULT_TYPE) return unknown('malformed-reply');
  if (data['version'] !== PROTOCOL_VERSION) return unknown('unsupported-version');
  if (!WAITING_STATES.has(data['worker'])) return unknown('worker-not-waiting');
  const windows = data['windows'];
  if (!Array.isArray(windows)) return unknown('malformed-reply');

  let requesters = 0;
  let others = 0;
  for (const entry of windows as unknown[]) {
    if (!isWindowEntry(entry)) return unknown('malformed-reply');
    if (entry.requester) requesters += 1;
    else if (entry.kind === 'application') others += 1;
  }
  if (requesters === 0) return unknown('requester-not-identified');
  if (requesters > 1) return unknown('malformed-reply');
  return others === 0 ? { status: 'safe' } : { status: 'blocked', otherApplicationWindows: others };
}

/**
 * Ask the waiting worker which windows are open and decide. Resolves, never rejects; a worker that does
 * not answer within `timeoutMs` (an older generation without the protocol, a hung worker) is unknown.
 */
export function inspectActivationSafety(
  worker: WaitingWorker | null | undefined,
  options: { readonly timeoutMs?: number } = {},
): Promise<ActivationSafety> {
  if (!worker) return Promise.resolve(unknown('no-waiting-worker'));
  let channel: MessageChannel;
  try {
    channel = new MessageChannel();
  } catch {
    return Promise.resolve(unknown('query-failed'));
  }
  const port = channel.port1;
  return new Promise<ActivationSafety>((resolve) => {
    let settled = false;
    const finish = (result: ActivationSafety): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      port.onmessage = null;
      port.close();
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(unknown('no-answer'));
    }, options.timeoutMs ?? DEFAULT_INSPECTION_TIMEOUT_MS);
    port.onmessage = (event: MessageEvent) => {
      finish(interpretWindowReply(event.data));
    };
    try {
      worker.postMessage({ type: REQUEST_TYPE, version: PROTOCOL_VERSION }, [channel.port2]);
    } catch {
      finish(unknown('query-failed'));
    }
  });
}
