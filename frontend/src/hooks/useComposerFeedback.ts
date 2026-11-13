import { useEffect, useId, useRef, useState } from 'react';

/** Local to a mounted composer: no stored drafts or cross-space state. */
export function useComposerFeedback() {
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const submitting = useRef(false);
  const id = useId();
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  return { error, setError, errorRef, submitting, errorId: `${id}-error`, hintId: `${id}-hint` };
}
