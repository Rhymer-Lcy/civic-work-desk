import { registerSW } from 'virtual:pwa-register';

/**
 * Service-worker registration and update prompting.
 *
 * The legacy prototype had **no service worker at all** (`grep -ci serviceworker` returns 0) and
 * generated its manifest at runtime as a `Blob` URL. Chrome requires a same-origin manifest *and*
 * a service worker with a fetch handler before it fires `beforeinstallprompt`, so the "安装到桌面"
 * button the prototype rendered could never appear, and the product claimed an installable
 * offline experience it did not have.
 *
 * Here registration is explicit, `registerType: 'prompt'` is used so an update never swaps the
 * running application out from under an open form, and the caller decides when to apply it.
 *
 * ## Other open pages when one of them applies the update (Phase 5.1)
 *
 * Prompt mode alone did not deliver that promise for a second tab. In vite-plugin-pwa 1.3.0,
 * `registerSW` makes every page that has shown the prompt listen for workbox-window's `controlling`
 * event and call `window.location.reload()` when a newer worker takes control, unless the caller
 * supplies `onNeedReload`. A worker that `skipWaiting()`s takes control of every page of the origin
 * at once, so pressing 应用更新 in one tab reloaded all the others, and a tab holding an unsaved form
 * lost its input (reproduced 2026-09-29; tests/e2e/update-safety.spec.ts). The plugin's
 * `updateServiceWorker(reloadPage)` ignores its argument in that version, so it offers no other lever.
 *
 * So `onNeedReload` is supplied, and only the page where the user pressed 应用更新 reloads. Every
 * other page moves to `activated-elsewhere`: it keeps its document, including any open form, and
 * tells its user that the new version is in control and that the page reloads only when they ask.
 * The same transition is also driven by a plain `controllerchange` listener, because the plugin adds
 * its `controlling` listener only after the prompt has been shown, and a page can be taken over
 * before it ever showed one.
 */

export type UpdateState = 'idle' | 'update-ready' | 'offline-ready' | 'activated-elsewhere';

export interface PwaController {
  /** Apply a waiting update and reload this page once the new worker controls it. */
  readonly applyUpdate: () => Promise<void>;
  /** Reload this page, at its user's request, onto the worker that now controls it. */
  readonly reloadPage: () => void;
  /**
   * Ask the browser to look for a newer worker now (Phase 5.1, runtime-generation mismatch). A worker
   * it finds installs and waits, which raises the ordinary prompt; nothing is activated or reloaded.
   * Never rejects: offline, or with no registration, it simply finds nothing.
   */
  readonly checkForUpdate: () => Promise<void>;
  readonly unregister: () => Promise<void>;
}

export interface RegisterOptions {
  readonly onStateChange: (state: UpdateState) => void;
}

let controller: PwaController | null = null;

/** Typed as always present, but absent in insecure contexts. */
function serviceWorkerContainer(): ServiceWorkerContainer | undefined {
  return (globalThis.navigator as Navigator | undefined)?.serviceWorker;
}

/**
 * The decisions, separated from the wiring so they can be tested without a browser.
 *
 * `reload` is the only way the page is ever reloaded, and it runs at most once: when this page
 * accepted the update and a newer worker has taken control, or when the user asks for it after
 * another page accepted. Every event after the take-over is ignored, so a later prompt cannot
 * replace the notice with a 应用更新 button that has nothing left to apply.
 */
export interface UpdateCoordinator {
  /** The user pressed 应用更新 in this page. */
  readonly accept: () => void;
  /** A newer worker now controls this page. Idempotent: several listeners report it. */
  readonly newerWorkerInControl: () => void;
  readonly needRefresh: () => void;
  readonly offlineReady: () => void;
  /** Reload at the user's request. */
  readonly reload: () => void;
}

export function createUpdateCoordinator(
  onStateChange: (state: UpdateState) => void,
  reload: () => void,
): UpdateCoordinator {
  let acceptedHere = false;
  let takenOver = false;
  let reloading = false;

  const reloadOnce = (): void => {
    if (reloading) return;
    reloading = true;
    reload();
  };

  return {
    accept: () => {
      acceptedHere = true;
    },
    newerWorkerInControl: () => {
      if (acceptedHere) {
        reloadOnce();
        return;
      }
      if (takenOver) return;
      takenOver = true;
      onStateChange('activated-elsewhere');
    },
    needRefresh: () => {
      if (!takenOver) onStateChange('update-ready');
    },
    offlineReady: () => {
      if (!takenOver) onStateChange('offline-ready');
    },
    reload: reloadOnce,
  };
}

export function registerServiceWorker(options: RegisterOptions): PwaController {
  if (controller) return controller;

  const coordinator = createUpdateCoordinator(options.onStateChange, () => {
    window.location.reload();
  });

  const container = serviceWorkerContainer();
  // Only a page that already had a worker can be taken over by a newer one; a first visit gets its
  // first controller on the next load, because the worker does not claim clients.
  const hadController = Boolean(container?.controller);
  container?.addEventListener('controllerchange', () => {
    if (hadController) coordinator.newerWorkerInControl();
  });

  const update = registerSW({
    immediate: true,
    onNeedRefresh: coordinator.needRefresh,
    onOfflineReady: coordinator.offlineReady,
    // Replaces the plugin's unconditional `window.location.reload()`; see the file header.
    onNeedReload: coordinator.newerWorkerInControl,
    onRegisterError(error: unknown) {
      // Registration failure is not fatal: the application works without a service worker, it
      // simply will not run offline. Reported rather than swallowed.
      console.warn('[pwa] service worker registration failed', error);
    },
  });

  controller = {
    applyUpdate: async () => {
      coordinator.accept();
      await update(true);
    },
    reloadPage: coordinator.reload,
    checkForUpdate: async () => {
      try {
        const registration = await serviceWorkerContainer()?.getRegistration();
        await registration?.update();
      } catch {
        // Offline, or the worker script could not be fetched: there is nothing newer to find now.
      }
    },
    unregister: async () => {
      const found = serviceWorkerContainer();
      if (!found) return;
      const registrations = await found.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
    },
  };
  return controller;
}

/** True when the page is running as an installed application rather than a browser tab. */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia('(display-mode: standalone)').matches) return true;
  if (window.matchMedia('(display-mode: window-controls-overlay)').matches) return true;
  // iOS Safari predates the display-mode media query for installed web apps.
  const legacy = (navigator as { standalone?: boolean }).standalone;
  return legacy === true;
}

/** The runtime mode, used by Settings to explain what is and is not supported. */
export type RuntimeMode = 'installed' | 'https' | 'localhost' | 'file' | 'other';

export function runtimeMode(): RuntimeMode {
  if (typeof window === 'undefined') return 'other';
  if (isStandalone()) return 'installed';
  const { protocol, hostname } = window.location;
  if (protocol === 'file:') return 'file';
  if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]') {
    return 'localhost';
  }
  if (protocol === 'https:') return 'https';
  return 'other';
}
