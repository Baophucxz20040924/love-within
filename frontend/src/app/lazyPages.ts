import { lazy, type ComponentType } from 'react';

/**
 * Pages outside the first screen (login + home) are split into their own chunks so the initial
 * bundle stays small. prefetchPages() downloads them in the background once the app is idle.
 */
const loaders = {
  pairing: () => import('../pages/PairingPage'),
  quests: () => import('../pages/QuestsPage'),
  water: () => import('../pages/WaterQuestPage'),
  approvals: () => import('../pages/ApprovalsPage'),
  market: () => import('../pages/MarketPage'),
  profile: () => import('../pages/ProfilePage'),
  stories: () => import('../pages/StoriesPage'),
  storyDetail: () => import('../pages/StoryDetailPage'),
  finance: () => import('../pages/FinancePage'),
  savings: () => import('../pages/SavingsPage'),
  savingsDetail: () => import('../pages/SavingsDetailPage'),
  financeGuide: () => import('../pages/FinanceGuidePage'),
  financeAssistant: () => import('../pages/FinanceAssistantPage'),
  questions: () => import('../pages/QuestionsPage'),
  questionDetail: () => import('../pages/QuestionDetailPage'),
  events: () => import('../pages/EventsPage'),
  letters: () => import('../pages/LettersPage'),
  letterDetail: () => import('../pages/LetterDetailPage'),
  notificationSettings: () => import('../pages/NotificationSettingsPage'),
  moodHistory: () => import('../pages/MoodHistoryPage'),
  bucket: () => import('../pages/BucketPage'),
  moments: () => import('../pages/MomentsPage'),
};

function page<K extends string, M extends Record<K, ComponentType>>(load: () => Promise<M>, name: K) {
  return lazy(async () => ({ default: (await load())[name] }));
}

export const PairingPage = page(loaders.pairing, 'PairingPage');
export const QuestsPage = page(loaders.quests, 'QuestsPage');
export const WaterQuestPage = page(loaders.water, 'WaterQuestPage');
export const ApprovalsPage = page(loaders.approvals, 'ApprovalsPage');
export const MarketPage = page(loaders.market, 'MarketPage');
export const ProfilePage = page(loaders.profile, 'ProfilePage');
export const StoriesPage = page(loaders.stories, 'StoriesPage');
export const StoryDetailPage = page(loaders.storyDetail, 'StoryDetailPage');
export const FinancePage = page(loaders.finance, 'FinancePage');
export const SavingsPage = page(loaders.savings, 'SavingsPage');
export const SavingsDetailPage = page(loaders.savingsDetail, 'SavingsDetailPage');
export const FinanceGuidePage = page(loaders.financeGuide, 'FinanceGuidePage');
export const FinanceAssistantPage = page(loaders.financeAssistant, 'FinanceAssistantPage');
export const QuestionsPage = page(loaders.questions, 'QuestionsPage');
export const QuestionDetailPage = page(loaders.questionDetail, 'QuestionDetailPage');
export const EventsPage = page(loaders.events, 'EventsPage');
export const LettersPage = page(loaders.letters, 'LettersPage');
export const LetterDetailPage = page(loaders.letterDetail, 'LetterDetailPage');
export const NotificationSettingsPage = page(loaders.notificationSettings, 'NotificationSettingsPage');
export const MoodHistoryPage = page(loaders.moodHistory, 'MoodHistoryPage');
export const BucketPage = page(loaders.bucket, 'BucketPage');
export const MomentsPage = page(loaders.moments, 'MomentsPage');
/** Public /install (N5): loaded on its own, not prefetched (most sessions open it once). */
export const InstallPage = page(() => import('../pages/InstallPage'), 'InstallPage');

/** Fetch every page chunk in the background (the browser caches them), so later tab switches are instant. */
export function prefetchPages(): void {
  for (const load of Object.values(loaders)) void load().catch(() => undefined);
}
