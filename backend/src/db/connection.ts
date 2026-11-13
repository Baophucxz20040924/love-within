import mongoose from 'mongoose';
import { env, isProd } from '../config/env.js';
import { logger } from '../utils/logger.js';

mongoose.set('strictQuery', true);

/** Connect to MongoDB (Atlas) using a small pool suited to a 2 vCPU / 4 GB VPS. */
export async function connectDb(): Promise<void> {
  try {
    await mongoose.connect(env.mongoUri, {
      maxPoolSize: 10,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 10_000,
      // In production, server.ts builds indexes once via syncIndexes(); auto-indexing would build them a second time.
      autoIndex: !isProd,
    });
    logger.info('MongoDB connected');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('MongoDB connection failed', { message });
    throw err;
  }

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', { message: err.message });
  });
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected');
  });
}

/** Ensure all model indexes are built at startup (idempotent). */
export async function syncIndexes(): Promise<void> {
  const names = Object.keys(mongoose.models);
  await Promise.all(names.map((name) => mongoose.models[name].syncIndexes()));
  logger.info('MongoDB indexes synced', { models: names.length });
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}

/** Readiness string for health checks. */
export function dbState(): string {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return states[mongoose.connection.readyState] ?? 'unknown';
}
