import { useSyncExternalStore } from 'react';

/**
 * "Cài app lên điện thoại" (plan/PLATFORM_PLAN.md, N5). Chrome / Edge on Android and desktop fire `beforeinstallprompt`
 * once the app is installable, often right after load, so main.tsx calls captureInstallPrompt() before the first render
 * and the /install page can show its "Cài app" button later. Safari (iPhone/iPad) has no such event: the page shows the
 * Share → "Thêm vào MH chính" steps instead.
 */

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform?: string }>;
}

interface InstallState {
  /** The browser offered an install prompt that was not used yet. */
  canPrompt: boolean;
  /** `appinstalled` fired in this session. */
  installed: boolean;
}

let deferred: BeforeInstallPromptEvent | null = null;
let state: InstallState = { canPrompt: false, installed: false };
let captured = false;
const listeners = new Set<() => void>();

function set(next: Partial<InstallState>): void {
  state = { ...state, ...next };
  for (const l of listeners) l();
}

/** Call once, as early as possible (main.tsx). */
export function captureInstallPrompt(): void {
  if (captured || typeof window === 'undefined') return;
  captured = true;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Keep Chrome's own mini-infobar away; the /install page and the browser menu offer the install.
    e.preventDefault();
    deferred = e as BeforeInstallPromptEvent;
    set({ canPrompt: true });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    set({ canPrompt: false, installed: true });
  });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useInstallState(): InstallState {
  return useSyncExternalStore(subscribe, () => state);
}

/** Show the browser's install dialog (the event can be used once). */
export async function promptInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  const e = deferred;
  if (!e) return 'unavailable';
  deferred = null;
  set({ canPrompt: false });
  await e.prompt();
  const choice = await e.userChoice;
  if (choice.outcome === 'accepted') set({ installed: true });
  return choice.outcome;
}

/** Running as the installed app (Android/desktop `display-mode: standalone`, iPhone home-screen app). */
export function isStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  const iosStandalone = (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return iosStandalone || window.matchMedia('(display-mode: standalone)').matches;
}

export type InstallPlatform = 'ios' | 'android' | 'other';

export interface DeviceInfo {
  platform: InstallPlatform;
  /** iPhone/iPad browser other than Safari (Chrome, Firefox, Edge on iOS). */
  iosNotSafari: boolean;
  /** Opened inside another app (Zalo, Facebook, Messenger, Instagram, Line): these cannot install a web app. */
  inApp: boolean;
}

export function detectDevice(ua = navigator.userAgent): DeviceInfo {
  // iPadOS 13+ reports a Mac user agent; a touch screen tells it apart.
  const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = !ios && /Android/.test(ua);
  const inApp = /Zalo|FBAN|FBAV|FB_IAB|Messenger|Instagram|Line\//i.test(ua);
  return {
    platform: ios ? 'ios' : android ? 'android' : 'other',
    iosNotSafari: ios && /CriOS|FxiOS|EdgiOS|OPiOS/.test(ua),
    inApp,
  };
}
