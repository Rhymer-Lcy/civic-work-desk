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
 */

export type UpdateState = 'idle' | 'update-ready' | 'offline-ready';

export interface PwaController {
  /** Apply a waiting update and reload. No-op when nothing is waiting. */
  readonly applyUpdate: () => Promise<void>;
  readonly unregister: () => Promise<void>;
}

export interface RegisterOptions {
  readonly onStateChange: (state: UpdateState) => void;
}

let controller: PwaController | null = null;

export function registerServiceWorker(options: RegisterOptions): PwaController {
  if (controller) return controller;

  let applyUpdate: (() => Promise<void>) | null = null;

  const update = registerSW({
    immediate: true,
    onNeedRefresh() {
      options.onStateChange('update-ready');
    },
    onOfflineReady() {
      options.onStateChange('offline-ready');
    },
    onRegisterError(error: unknown) {
      // Registration failure is not fatal: the application works without a service worker, it
      // simply will not run offline. Reported rather than swallowed.
      console.warn('[pwa] service worker registration failed', error);
    },
  });

  applyUpdate = async () => {
    await update(true);
  };

  controller = {
    applyUpdate: async () => {
      await applyUpdate();
    },
    unregister: async () => {
      // Typed as always present, but absent in insecure contexts.
      const container: ServiceWorkerContainer | undefined = (
        globalThis.navigator as Navigator | undefined
      )?.serviceWorker;
      if (!container) return;
      const registrations = await container.getRegistrations();
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
