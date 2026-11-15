import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { privacyVersion, subscribePrivacy } from '../privacy/store';

export function useSecretEntry(enabled: boolean, onBoard: () => void, resetKey: string) {
  const taps = useRef(0);
  const phase = useRef<'idle' | 'armed' | 'sailing' | 'navigating'>('idle');
  const [boatOpen, setBoatOpen] = useState(false);
  const markRef = useRef<HTMLButtonElement>(null);
  const version = useSyncExternalStore(subscribePrivacy, privacyVersion);
  function reset() { taps.current = 0; phase.current = 'idle'; setBoatOpen(false); }
  useEffect(reset, [resetKey, version]);
  function onHeartTap() {
    if (!enabled || phase.current === 'sailing' || phase.current === 'navigating') return;
    taps.current = Math.min(4, taps.current + 1);
    if (taps.current === 4) phase.current = 'armed';
    if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      markRef.current?.animate([{ transform: 'scale(1)' }, { transform: 'scale(.9)' }, { transform: 'scale(1)' }], { duration: 220, easing: 'ease-out' });
    }
    if (taps.current === 4) navigator.vibrate?.(12);
  }
  function revealBoat() {
    if (!enabled) return false;
    if (phase.current === 'sailing' || phase.current === 'navigating') return true;
    if (phase.current !== 'armed') return false;
    phase.current = 'sailing'; setBoatOpen(true); return true;
  }
  function dismissBoat() {
    const restore = document.activeElement instanceof HTMLElement && !!document.activeElement.closest('.secret-boat');
    reset();
    if (restore) markRef.current?.focus({ preventScroll: true });
  }
  function boardBoat() {
    if (phase.current !== 'sailing') return;
    phase.current = 'navigating'; onBoard();
  }
  return { boatOpen, markRef, onHeartTap, revealBoat, dismissBoat, boardBoat };
}
