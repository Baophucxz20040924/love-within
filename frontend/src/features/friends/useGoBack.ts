import { useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

/** Back to the previous screen of the app (React Router keeps `idx` in history.state), else to `fallback`. */
export function useGoBack(fallback: string): () => void {
  const navigate = useNavigate();
  return useCallback(() => {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate(fallback, { replace: true });
  }, [navigate, fallback]);
}
