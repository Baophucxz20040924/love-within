import type { ReactNode } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../features/auth/AuthContext';
import { homeOf, type Space } from '../lib/spaceStore';

/**
 * Keep a session inside the space it logged into: the couple app and the hidden friends space never
 * show each other's screens. Unauthenticated users are handled by ProtectedRoute before this.
 */
export function RequireSpace({ space, children }: { space: Space; children: ReactNode }) {
  const { space: current } = useAuth();
  if (current !== space) return <Navigate to={homeOf(current)} replace />;
  return <>{children}</>;
}
