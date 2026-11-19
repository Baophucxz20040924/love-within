import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb, syncIndexes, disconnectDb } from './db/connection.js';
import { questService } from './services/quest.service.js';
import { startResourceMonitor, stopResourceMonitor } from './utils/monitor.js';
import { startBankSync, stopBankSync } from './services/bankSync.service.js';
import { startScheduler, stopScheduler } from './services/scheduler.service.js';
import { drainPush } from './services/push.service.js';
import { logger } from './utils/logger.js';
import { realtimeService, assertSingleRealtimeProcess } from './services/realtime.service.js';

let startupSection = 'connectDb';

async function bootstrap(): Promise<void> {
  assertSingleRealtimeProcess();
  await connectDb();
  startupSection = 'syncIndexes';
  await syncIndexes();
  startupSection = 'seedDefaults';
  await questService.seedDefaults();

  startupSection = 'createApp';
  const app = createApp();
  startupSection = 'listen';

  const server = app.listen(env.port, () => {
    logger.info(`Look Within API listening on port ${env.port}`, { env: env.nodeEnv });
  });
  startResourceMonitor();
  startBankSync();
  startScheduler();

  let shutdownPromise: Promise<void> | null = null;
  const shutdown = (signal: string): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      logger.info(`Received ${signal}, shutting down`);
      stopResourceMonitor();
      const bankStopped = stopBankSync();
      const schedulerStopped = stopScheduler();
      realtimeService.drain();
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      await Promise.all([closed, bankStopped, schedulerStopped]);
      await drainPush();
      await disconnectDb();
      process.exit(0);
    })();
    return shutdownPromise;
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err: unknown) => {
  // Never log arbitrary error messages: Mongo errors can contain URIs or user data.
  const details = typeof err === 'object' && err !== null ? err as Record<string, unknown> : {};
  logger.error('Fatal startup error', {
    section: startupSection,
    kind: err instanceof Error ? err.name : 'Unknown',
    ...(typeof details.code === 'number' ? { code: details.code } : {}),
    ...(typeof details.codeName === 'string' ? { status: details.codeName } : {}),
  });
  process.exit(1);
});
