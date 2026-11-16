import { lazy, Suspense } from 'react';
import { BrowserRouter, useLocation } from 'react-router-dom';

// Do not statically import the personal tree: its lock modules have browser lifecycle listeners.
// Admin pages never mount personal AuthProvider, query client, PIN, push or realtime components.
const PersonalApp = lazy(() => import('./PersonalApp').then(module => ({ default: module.PersonalApp })));
const AdminApp = lazy(() => import('../features/admin/AdminApp').then(module => ({ default: module.AdminApp })));

function Shell() {
  const { pathname } = useLocation();
  const admin = pathname === '/admin' || pathname.startsWith('/admin/');
  return <Suspense fallback={<div role="status" className="state">Đang tải…</div>}>
    {admin ? <AdminApp /> : <PersonalApp />}
  </Suspense>;
}

export function App() {
  return <BrowserRouter><Shell /></BrowserRouter>;
}
