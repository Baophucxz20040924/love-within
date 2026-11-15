import { cloneElement, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from '../features/auth/AuthContext';
import { ToastProvider } from '../components/Toast';
import { ErrorState, Loading } from '../components/StatusViews';
import { ProtectedRoute } from './ProtectedRoute';
import { RequireCouple } from './RequireCouple';
import { RequireSpace } from './RequireSpace';
import { AppLayout } from '../components/AppLayout';
import { RouteNavigation } from '../components/RouteNavigation';
import { AuthPage } from '../pages/AuthPage';
import { HomePage } from '../pages/HomePage';
import { homeOf } from '../lib/spaceStore';
import { useFriendsTheme } from '../features/friends/useFriendsTheme';
import { PushSync } from '../features/push/PushSync';
import { RealtimeSync } from '../features/realtime/RealtimeSync';
import { RealtimeBoundary } from '../features/realtime/verification';
import { PrivacyCover, PrivacyRoutes } from '../features/privacy/PrivacyBoundary';
import { canEnterHidden } from '../features/privacy/store';
import {
  ApprovalsPage,
  BucketPage,
  EventsPage,
  FinanceAssistantPage,
  FinanceGuidePage,
  FinancePage,
  InstallPage,
  LetterDetailPage,
  LettersPage,
  MarketPage,
  MoodHistoryPage,
  MomentsPage,
  NotificationSettingsPage,
  PairingPage,
  ProfilePage,
  QuestionDetailPage,
  QuestionsPage,
  QuestsPage,
  SavingsPage,
  SavingsDetailPage,
  StoriesPage,
  StoryDetailPage,
  WaterQuestPage,
} from './lazyPages';
import {
  FriendEventPage,
  FriendEventsPage,
  FriendOutingsPage,
  FriendOutingPage,
  FriendPostPage,
  FriendProfilePage,
  FriendsBlockedPage,
  FriendsFeedPage,
  FriendsInvitesPage,
  FriendsLayout,
  FriendsMePage,
  FriendsNotificationSettingsPage,
  FriendsNotificationsPage,
  FriendsPeoplePage,
  InviteLandingPage,
} from '../features/friends/lazyPages';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, staleTime: 30_000, refetchOnWindowFocus: false },
  },
});

const FRIENDS_LOGIN = '/friends/login';

function LoginRoute() {
  const { isAuthenticated, space } = useAuth();
  if (isAuthenticated) return <Navigate to={homeOf(space)} replace />;
  return <AuthPage />;
}

/** Hidden login requires a live document gesture; old history state never grants entry. */
function FriendsLoginRoute() {
  const { isAuthenticated, space } = useAuth();
  const location = useLocation();
  const state = location.state as { unlocked?: boolean; mode?: 'login' | 'register'; invite?: { code: string; inviterName: string } } | null;
  if (isAuthenticated) return <Navigate to={homeOf(space)} replace />;
  if (!canEnterHidden()) return <Navigate to="/login" replace />;
  return <AuthPage variant="friends" invite={state?.invite} initialMode={state?.mode} />;
}

/** Blue theme while the session is in the friends space or on its hidden login page. */
function SpaceTheme() {
  const { space } = useAuth();
  const { pathname } = useLocation();
  const onHiddenLogin = pathname === FRIENDS_LOGIN && canEnterHidden();
  useFriendsTheme(space === 'friends' || onHiddenLogin);
  return null;
}

function PairingRoute() {
  const { me } = useAuth();
  if (me?.user.coupleId) return <Navigate to="/" replace />;
  return (
    <Suspense fallback={<Loading />}>
      <PairingPage />
    </Suspense>
  );
}

function AuthBootstrapBoundary({ children, location }: { children: import('react').ReactElement<{ location?: ReturnType<typeof useLocation> }>; location?: ReturnType<typeof useLocation> }) {
  const { bootstrapError, loading, retryBootstrap } = useAuth();
  if (bootstrapError) return <main className="app-content"><ErrorState title="Chưa kiểm tra được phiên đăng nhập" message="Phiên của bạn vẫn được giữ. Thử tải lại thay vì đăng nhập lại." onRetry={retryBootstrap} />{loading && <Loading />}</main>;
  return cloneElement(children, { location });
}

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <PrivacyCover />
          <AuthProvider>
            <SpaceTheme />
            <RouteNavigation />
            <PushSync />
            <RealtimeSync />
            <RealtimeBoundary><PrivacyRoutes><AuthBootstrapBoundary><Routes>
              <Route path="/login" element={<LoginRoute />} />
              <Route path={FRIENDS_LOGIN} element={<FriendsLoginRoute />} />
              <Route
                path="/pairing"
                element={
                  <ProtectedRoute>
                    <RequireSpace space="couple">
                      <PairingRoute />
                    </RequireSpace>
                  </ProtectedRoute>
                }
              />
              <Route
                element={
                  <ProtectedRoute>
                    <RequireSpace space="couple">
                      <RequireCouple>
                        <AppLayout />
                      </RequireCouple>
                    </RequireSpace>
                  </ProtectedRoute>
                }
              >
                <Route path="/" element={<HomePage />} />
                <Route path="/quests" element={<QuestsPage />} />
                {/* Water is a quest: it lives under /quests, not in the main navigation. */}
                <Route path="/quests/water" element={<WaterQuestPage />} />
                <Route path="/water" element={<Navigate to="/quests/water" replace />} />
                {/* Shared bucket list (CP3): card in the Quests tab → here. */}
                <Route path="/quests/bucket" element={<BucketPage />} />
                <Route path="/approvals" element={<ApprovalsPage />} />
                <Route path="/stories" element={<StoriesPage />} />
                <Route path="/stories/:id" element={<StoryDetailPage />} />
                <Route path="/market" element={<MarketPage />} />
                <Route path="/finance" element={<FinancePage />} />
                <Route path="/savings" element={<SavingsPage />} />
                <Route path="/savings/:id" element={<SavingsDetailPage />} />
                <Route path="/finance/guide" element={<FinanceGuidePage />} />
                <Route path="/finance/assistant" element={<FinanceAssistantPage />} />
                {/* Daily question (CP1): Home card + quest; history and one day's answers here. */}
                <Route path="/questions" element={<QuestionsPage />} />
                <Route path="/questions/:id" element={<QuestionDetailPage />} />
                {/* Countdown events (CP4): Home card "Sắp tới" and Hồ sơ → here. */}
                <Route path="/events" element={<EventsPage />} />
                {/* Timed letters (CP2): ✉️ in the Story header, Home card when a letter can be opened. */}
                <Route path="/letters" element={<LettersPage />} />
                <Route path="/letters/:id" element={<LetterDetailPage />} />
                {/* Duo moment (CP6): Home card while open, the quest, the 📷 in the Story header → here. */}
                <Route path="/moments" element={<MomentsPage />} />
                <Route path="/profile" element={<ProfilePage />} />
                {/* Web Push (N4): Hồ sơ → "Thông báo". */}
                <Route path="/profile/notifications" element={<NotificationSettingsPage />} />
                {/* Mood of the day (CP5): set in the Home Hero; Hồ sơ → "Cảm xúc 30 ngày". */}
                <Route path="/profile/moods" element={<MoodHistoryPage />} />
              </Route>
              {/* Hidden friends space ("Hội bạn bè"): no couple needed. */}
              <Route
                path="/friends"
                element={
                  <ProtectedRoute>
                    <RequireSpace space="friends">
                      <Suspense fallback={<Loading />}>
                        <FriendsLayout />
                      </Suspense>
                    </RequireSpace>
                  </ProtectedRoute>
                }
              >
                <Route index element={<FriendsFeedPage />} />
                <Route path="people" element={<FriendsPeoplePage />} />
                <Route path="posts/:id" element={<FriendPostPage />} />
                {/* "Lên kèo" (BB5): feed strip "Kèo sắp tới" → here. */}
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
              {/* Invite link into the friends space: public, neutral path. */}
              <Route
                path="/j/:code"
                element={
                  <Suspense fallback={<Loading />}>
                    <InviteLandingPage />
                  </Suspense>
                }
              />
              {/* How to install the app on a phone (N5): public, same page for every session. */}
              <Route
                path="/install"
                element={
                  <Suspense fallback={<Loading />}>
                    <InstallPage />
                  </Suspense>
                }
              />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Routes></AuthBootstrapBoundary></PrivacyRoutes></RealtimeBoundary>
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  );
}
