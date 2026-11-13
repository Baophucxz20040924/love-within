import { env, isProd } from '../config/env.js';
import { logger } from '../utils/logger.js';
import type { StorageProvider } from './storage/StorageProvider.js';
import { S3StorageAdapter } from './storage/S3StorageAdapter.js';
import { MemoryStorageAdapter } from './storage/MemoryStorageAdapter.js';
import type { WaterVisionProvider } from './ai/WaterVisionProvider.js';
import { BeeknoeeAdapter } from './ai/BeeknoeeAdapter.js';
import { MockVisionAdapter } from './ai/MockVisionAdapter.js';
import type { ChatProvider } from './ai/ChatProvider.js';
import { BeeknoeeChatAdapter } from './ai/BeeknoeeChatAdapter.js';
import { MockChatAdapter } from './ai/MockChatAdapter.js';
import type { BankFeedProvider } from './bank/BankFeedProvider.js';
import { ThueApiBankAdapter } from './bank/ThueApiBankAdapter.js';
import { MockBankAdapter } from './bank/MockBankAdapter.js';
import type { PushProvider } from './push/PushProvider.js';
import { WebPushAdapter } from './push/WebPushAdapter.js';
import { MockPushAdapter } from './push/MockPushAdapter.js';

let storage: StorageProvider | null = null;
let vision: WaterVisionProvider | null = null;
let memoryStorage: MemoryStorageAdapter | null = null;
let bankFeed: BankFeedProvider | null = null;
let chat: ChatProvider | null = null;
let push: PushProvider | null = null;
let mockPush: MockPushAdapter | null = null;

export function getStorage(): StorageProvider {
  if (storage) return storage;
  if (env.storageProvider === 'memory') {
    if (isProd) throw new Error('STORAGE_PROVIDER=memory is not allowed in production');
    // Relative URLs go through the Vite dev proxy, so uploads also work from a phone on the LAN.
    memoryStorage = new MemoryStorageAdapter('');
    storage = memoryStorage;
    logger.warn('Using in-memory storage adapter (dev only)');
  } else {
    storage = new S3StorageAdapter();
  }
  return storage;
}

/** Only non-null when STORAGE_PROVIDER=memory; used to mount the fake upload endpoint. */
export function getMemoryStorage(): MemoryStorageAdapter | null {
  getStorage();
  return memoryStorage;
}

export function getVision(): WaterVisionProvider {
  if (vision) return vision;
  if (env.aiProvider === 'mock') {
    if (isProd) throw new Error('AI_PROVIDER=mock is not allowed in production');
    vision = new MockVisionAdapter();
    logger.warn('Using mock water-vision adapter (dev only)');
  } else {
    vision = new BeeknoeeAdapter();
  }
  return vision;
}

/** Finance assistant text chat (AI_CHAT_PROVIDER, defaults to AI_PROVIDER). */
export function getChat(): ChatProvider {
  if (chat) return chat;
  if (env.aiChatProvider === 'mock') {
    if (isProd) throw new Error('AI_CHAT_PROVIDER=mock is not allowed in production');
    chat = new MockChatAdapter();
    logger.warn('Using mock chat adapter (dev only)');
  } else if (env.aiChatProvider === 'beeknoee') {
    chat = new BeeknoeeChatAdapter();
  } else {
    throw new Error(`Unknown AI_CHAT_PROVIDER "${env.aiChatProvider}" (expected beeknoee | mock)`);
  }
  return chat;
}

export function getBankFeed(): BankFeedProvider {
  if (bankFeed) return bankFeed;
  if (env.bank.provider === 'mock') {
    if (isProd) throw new Error('BANK_PROVIDER=mock is not allowed in production');
    bankFeed = new MockBankAdapter();
    logger.warn('Using mock bank feed adapter (dev only)');
  } else if (env.bank.provider === 'thueapibank') {
    bankFeed = new ThueApiBankAdapter();
  } else {
    throw new Error(`Unknown BANK_PROVIDER "${env.bank.provider}" (expected thueapibank | mock)`);
  }
  return bankFeed;
}

/** Web Push (PUSH_PROVIDER: webpush | mock). Without VAPID keys the webpush adapter is disabled (one WARN at startup). */
export function getPush(): PushProvider {
  if (push) return push;
  if (env.push.provider === 'mock') {
    if (isProd) throw new Error('PUSH_PROVIDER=mock is not allowed in production');
    mockPush = new MockPushAdapter(env.push.vapidPublicKey || null);
    push = mockPush;
    logger.warn('Using mock push adapter (dev only)');
  } else if (env.push.provider === 'webpush') {
    push = new WebPushAdapter(env.push);
  } else {
    throw new Error(`Unknown PUSH_PROVIDER "${env.push.provider}" (expected webpush | mock)`);
  }
  return push;
}

/** Only non-null when PUSH_PROVIDER=mock; used to mount the dev endpoint /api/dev-push. */
export function getMockPush(): MockPushAdapter | null {
  getPush();
  return mockPush;
}
