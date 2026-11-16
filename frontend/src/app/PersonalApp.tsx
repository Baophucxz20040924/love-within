import { Suspense, useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../features/auth/AuthContext';
import { ToastProvider } from '../components/Toast';
import { Loading } from '../components/StatusViews';
import { ProtectedRoute } from './ProtectedRoute';
import { RequireCouple } from './RequireCouple';
import { RequireSpace } from './RequireSpace';
import { AppLayout } from '../components/AppLayout';
import { RouteNavigation } from '../components/RouteNavigation';
import { AuthPage } from '../pages/AuthPage';
import { PasswordChangePage } from '../pages/PasswordChangePage';
import { HomePage } from '../pages/HomePage';
import { homeOf } from '../lib/spaceStore';
import { useFriendsTheme } from '../features/friends/useFriendsTheme';
import { PushSync } from '../features/push/PushSync';
import { RealtimeSync } from '../features/realtime/RealtimeSync';
import { RealtimeBoundary } from '../features/realtime/verification';
import { AppLockBoundary, AppLockCover } from '../features/appLock/AppLockBoundary';
import { AppLockSettingsPage } from '../pages/AppLockSettingsPage';
import {
  CoupleNotificationsPage, BucketPage, EventsPage, FinanceAssistantPage, FinanceGuidePage,
  FinancePage, InstallPage, LetterDetailPage, LettersPage, MarketPage, MoodHistoryPage,
  MomentsPage, NotificationSettingsPage, PairingPage, ProfilePage, QuestionDetailPage,
  QuestionsPage, QuestsPage, SavingsPage, SavingsDetailPage, StoriesPage, StoryDetailPage, WaterQuestPage,
} from './lazyPages';
import {
  FriendEventPage, FriendEventsPage, FriendOutingsPage, FriendOutingPage, FriendPostPage,
  FriendProfilePage, FriendsBlockedPage, FriendsFeedPage, FriendsInvitesPage, FriendsLayout,
  FriendsMePage, FriendsNotificationSettingsPage, FriendsNotificationsPage, FriendsPeoplePage, InviteLandingPage,
} from '../features/friends/lazyPages';

const queryClient = new QueryClient({ defaultOptions: { queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false } } });
const FRIENDS_LOGIN = '/friends/login';

function LoginRoute() {
  const { isAuthenticated, space } = useAuth();
  if (isAuthenticated) return <Navigate to={homeOf(space)} replace />;
  return <AuthPage />;
}

/** Hidden Friends login still requires the boat or an invite's history marker. */
function FriendsLoginRoute() {
  const { isAuthenticated, space } = useAuth();
  const location = useLocation();
  const state = location.state as { unlocked?: boolean; mode?: 'login' | 'register'; invite?: { code: string; inviterName: string } } | null;
  if (isAuthenticated) return <Navigate to={homeOf(space)} replace />;
  if (!state?.unlocked) return <Navigate to="/login" replace />;
  return <AuthPage variant="friends" invite={state.invite} initialMode={state.mode} />;
}

function SpaceTheme() {
  const { space } = useAuth();
  const { pathname, state } = useLocation();
  const onHiddenLogin = pathname === FRIENDS_LOGIN && Boolean((state as { unlocked?: boolean } | null)?.unlocked);
  useFriendsTheme(space === 'friends' || onHiddenLogin);
  return null;
}

function PairingRoute() {
  const { me } = useAuth();
  if (me?.user.coupleId) return <Navigate to="/" replace />;
  return <Suspense fallback={<Loading />}><PairingPage /></Suspense>;
}

/** Loaded only outside /admin; the personal cache and all personal effects live in this subtree. */
export function PersonalApp() {
  return <QueryClientProvider client={queryClient}><ToastProvider><AuthProvider><PersonalContent /></AuthProvider></ToastProvider></QueryClientProvider>;
}

function PersonalContent() {
  const { passwordChange, cancelPasswordChange } = useAuth();
  const location = useLocation();
  const recoveryOrigin = useRef<string | null>(null);
  const enteredRecovery = useRef(false);
  useEffect(() => {
    if (!passwordChange) { recoveryOrigin.current = null; enteredRecovery.current = false; return; }
    if (recoveryOrigin.current === null) recoveryOrigin.current = location.key;
    if (location.pathname === '/password-change') enteredRecovery.current = true;
    else if (enteredRecovery.current || recoveryOrigin.current !== location.key) cancelPasswordChange();
  }, [passwordChange, location, cancelPasswordChange]);
  if (passwordChange) return location.pathname === '/password-change' ? <PasswordChangePage /> : <Navigate to="/password-change" replace />;
  if (location.pathname === '/password-change') return <Navigate to="/login" replace />;
  return <>
    <AppLockCover />
    <SpaceTheme />
    <RouteNavigation />
    <PushSync />
    <RealtimeSync />
    <RealtimeBoundary><AppLockBoundary><Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path={FRIENDS_LOGIN} element={<FriendsLoginRoute />} />
      <Route path="/profile/app-lock" element={<ProtectedRoute><RequireSpace space="couple"><AppLockSettingsPage space="couple" /></RequireSpace></ProtectedRoute>} />
      <Route path="/friends/me/app-lock" element={<ProtectedRoute><RequireSpace space="friends"><AppLockSettingsPage space="friends" /></RequireSpace></ProtectedRoute>} />
      <Route path="/pairing" element={<ProtectedRoute><RequireSpace space="couple"><PairingRoute /></RequireSpace></ProtectedRoute>} />
      <Route element={<ProtectedRoute><RequireSpace space="couple"><RequireCouple><AppLayout /></RequireCouple></RequireSpace></ProtectedRoute>}>
        <Route path="/" element={<HomePage />} />
        <Route path="/quests" element={<QuestsPage />} />
        <Route path="/quests/water" element={<WaterQuestPage />} />
        <Route path="/water" element={<Navigate to="/quests/water" replace />} />
        <Route path="/quests/bucket" element={<BucketPage />} />
        <Route path="/notifications" element={<CoupleNotificationsPage />} />
        <Route path="/approvals" element={<Navigate to="/notifications?filter=approvals" replace />} />
        <Route path="/stories" element={<StoriesPage />} />
        <Route path="/stories/:id" element={<StoryDetailPage />} />
        <Route path="/market" element={<MarketPage />} />
        <Route path="/finance" element={<FinancePage />} />
        <Route path="/savings" element={<SavingsPage />} />
        <Route path="/savings/:id" element={<SavingsDetailPage />} />
        <Route path="/finance/guide" element={<FinanceGuidePage />} />
        <Route path="/finance/assistant" element={<FinanceAssistantPage />} />
        <Route path="/questions" element={<QuestionsPage />} />
        <Route path="/questions/:id" element={<QuestionDetailPage />} />
        <Route path="/events" element={<EventsPage />} />
        <Route path="/letters" element={<LettersPage />} />
        <Route path="/letters/:id" element={<LetterDetailPage />} />
        <Route path="/moments" element={<MomentsPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/profile/notifications" element={<NotificationSettingsPage />} />
        <Route path="/profile/moods" element={<MoodHistoryPage />} />
      </Route>
      <Route path="/friends" element={<ProtectedRoute><RequireSpace space="friends"><Suspense fallback={<Loading />}><FriendsLayout /></Suspense></RequireSpace></ProtectedRoute>}>
        <Route index element={<FriendsFeedPage />} />
        <Route path="people" element={<FriendsPeoplePage />} />
        <Route path="posts/:id" element={<FriendPostPage />} />
        <Route path="events" element={<FriendEventsPage />} />
        <Route path="events/:id" element={<FriendEventPage />} />
        <Route path="outings" element={<FriendOutingsPage />} />
        <Route path="outings/:id" element={<FriendOutingPage />} />
        <Route path="notifications" element={<FriendsNotificationsPage />} />
        <Route path="u/:userId" element={<FriendProfilePage />} />
        <Route path="me" element={<FriendsMePage />} />
        <Route path="me/blocked" element={<FriendsBlockedPage />} />
        <Route path="me/invites" element={<FriendsInvitesPage />} />
        <Route path="me/notifications" element={<FriendsNotificationSettingsPage />} />
      </Route>
      <Route path="/j/:code" element={<Suspense fallback={<Loading />}><InviteLandingPage /></Suspense>} />
      <Route path="/install" element={<Suspense fallback={<Loading />}><InstallPage /></Suspense>} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes></AppLockBoundary></RealtimeBoundary>
  </>;
}
