import { Icon } from '../../components/Icon';

export type EnvelopeState = 'sealed' | 'ready' | 'opening';

/**
 * A drawn envelope (CSS only, no image files). "opening" plays the short animation: the flap folds up, the seal fades and
 * the letter slides out (about 0.9 s; the global prefers-reduced-motion rule makes it instant).
 */
export function Envelope({ state, small = false }: { state: EnvelopeState; small?: boolean }) {
  return (
    <div className={`envelope envelope--${state}${small ? ' envelope--sm' : ''}`} aria-hidden="true">
      <div className="envelope__back" />
      <div className="envelope__paper" />
      <div className="envelope__pocket" />
      <div className="envelope__flap" />
      <div className="envelope__seal">
        <Icon name={state === 'sealed' ? 'lock' : 'heart'} size={small ? 14 : 20} strokeWidth={2.5} />
      </div>
    </div>
  );
}

/** Animation length (ms) the page waits for before showing the letter. */
export const ENVELOPE_OPEN_MS = 950;

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}
