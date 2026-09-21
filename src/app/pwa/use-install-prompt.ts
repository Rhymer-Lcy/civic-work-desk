import { useCallback, useEffect, useState } from 'react';
import { isStandalone } from './service-worker-bridge';

/**
 * The browser install prompt.
 *
 * `beforeinstallprompt` is non-standard but is the only path to a one-click install in Chromium.
 * Where it is absent (Firefox, Safari) the UI says so and explains the browser-menu route rather
 * than showing a button that does nothing — the legacy `triggerInstall()` rendered its button
 * whenever the event had fired, but since the prototype had no service worker the event never
 * fired at all, so the install path was dead in every browser.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallAvailability = 'available' | 'installed' | 'unavailable';

export interface InstallPrompt {
  readonly availability: InstallAvailability;
  readonly promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export function useInstallPrompt(): InstallPrompt {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => isStandalone());

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event): void => {
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = (): void => {
      setDeferred(null);
      setInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    if (!deferred) return 'unavailable';
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    // The event may only be used once.
    setDeferred(null);
    return outcome;
  }, [deferred]);

  const availability: InstallAvailability = installed
    ? 'installed'
    : deferred !== null
      ? 'available'
      : 'unavailable';

  return { availability, promptInstall };
}
