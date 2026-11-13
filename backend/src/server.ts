import { createApp } from './app.js';
import { env } from './config/env.js';
import { connectDb, syncIndexes, disconnectDb } from './db/connection.js';
import { questService } from './services/quest.service.js';
import { startResourceMonitor, stopResourceMonitor } from './utils/monitor.js';
import { startBankSync, stopBankSync } from './services/bankSync.service.js';
import { startScheduler, stopScheduler } from './services/scheduler.service.js';
import { logger } from './utils/logger.js';

async function bootstrap(): Promise<void> {
  await connectDb();
  await syncIndexes();
  await questService.seedDefaults();

  const app = createApp();
  const server = app.listen(env.port, () => {
    logger.info(`Look Within API listening on port ${env.port}`, { env: env.nodeEnv });
  });
  startResourceMonitor();
  startBankSync();
  startScheduler();

  const shutdown = async (signal: string): Promise<void> => {
    logger.info(`Received ${signal}, shutting down`);
    stopResourceMonitor();
    stopBankSync();
    // Stops the loop now; resolves when a running tick has finished (at most 10 s).
    const schedulerStopped = stopScheduler();
    server.close(async () => {
      await schedulerStopped;
      await disconnectDb();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

bootstrap().catch((err) => {
  logger.error('Fatal startup error', { message: err instanceof Error ? err.message : String(err) });
  process.exit(1);
});
