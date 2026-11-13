import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';

/** Gate couple-only features: redirect unpaired users to the pairing flow. */
export function RequireCouple({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  if (!me?.user.coupleId) return <Navigate to="/pairing" replace />;
  return <>{children}</>;
}
