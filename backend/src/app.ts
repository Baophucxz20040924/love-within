import express, { type Express } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { z } from 'zod';
import { env, isProd } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import { healthRouter } from './routes/health.routes.js';
import { authRouter } from './routes/auth.routes.js';
import { meRouter } from './routes/me.routes.js';
import { pairingRouter } from './routes/pairing.routes.js';
import { coupleRouter } from './routes/couple.routes.js';
import { proposalRouter } from './routes/proposal.routes.js';
import { walletRouter } from './routes/wallet.routes.js';
import { questRouter } from './routes/quest.routes.js';
import { waterRouter } from './routes/water.routes.js';
import { marketRouter } from './routes/market.routes.js';
import { storyRouter } from './routes/story.routes.js';
import { questionRouter } from './routes/question.routes.js';
import { eventRouter } from './routes/event.routes.js';
import { letterRouter } from './routes/letter.routes.js';
import { moodRouter, nudgeRouter } from './routes/nudge.routes.js';
import { bucketRouter } from './routes/bucket.routes.js';
import { momentRouter } from './routes/moment.routes.js';
import { savingsRouter } from './routes/savings.routes.js';
import { financeRouter } from './routes/finance.routes.js';
import { friendsRouter } from './routes/friends.routes.js';
import { friendStoryRouter } from './routes/friendStory.routes.js';
import { friendEventRouter } from './routes/friendEvent.routes.js';
import { publicRouter } from './routes/public.routes.js';
import { devSchedulerRouter } from './routes/devScheduler.routes.js';
import { pushRouter } from './routes/push.routes.js';
import { devPushRouter } from './routes/devPush.routes.js';
import { registerAllProposalHandlers } from './services/proposalHandlers/index.js';
import { registerAllJobs } from './services/jobs/index.js';
import { getMemoryStorage, getMockPush } from './integrations/index.js';
import { requestMetrics, metricArea } from './middleware/requestMetrics.js';
import { requestCorrelation } from './middleware/requestCorrelation.js';
import { apiNoStore } from './middleware/security.js';
import { edgeLimiter } from './middleware/rateLimit.js';
import { friendOutingRouter } from './routes/friendOuting.routes.js';
import { registerFriendOutingNotifications } from './services/friendOutingNotifications.js';
import { realtimeRouter } from './routes/realtime.routes.js';

export function createApp(): Express {
  // Validation errors are shown to users: give zod's built-in messages in Vietnamese (custom messages are unaffected).
  z.config(z.locales.vi());
  registerAllProposalHandlers();
  registerFriendOutingNotifications();
  // Background jobs (N2): the loop (server.ts → startScheduler) and the dev endpoint below share this registry.
  registerAllJobs();
  const app = express();
  app.disable('x-powered-by');

  // Behind a reverse proxy in production: trust N hops so req.ip / rate limiting use the client IP.
  // 1 = one proxy (Nginx/Caddy), 2 = CloudFront + Caddy.
  app.set('trust proxy', env.trustProxyHops);
  // Security headers (nosniff, frame denial, HSTS, restrictive CSP for anything rendered from the API origin).
  // Correlation and metrics precede CORS, limiters and parsers, including preflight/error responses.
  app.use(requestCorrelation, requestMetrics);
  app.use(helmet());
  app.use(cors({ origin: env.corsOrigin, credentials: true, exposedHeaders: ['X-Request-ID'] }));
  app.use('/api', apiNoStore, edgeLimiter);

  // Dev-only fake "S3" endpoint (raw bodies) — mounted before the JSON parser.
  const mem = getMemoryStorage();
  if (mem) app.use('/api/dev-storage', mem.router(env.s3.maxUploadBytes, 50 * 1024 * 1024));

  // The largest legitimate body is a 20 000-character story (~60 KB); a tighter cap limits parse/validation cost.
  app.use(express.json({ limit: '256kb' }));

  // Routes
  app.use('/api', healthRouter);
  app.use('/api/auth', authRouter);
  app.use('/api/realtime', realtimeRouter);
  app.use('/api', meRouter);
  app.use('/api/pairing', pairingRouter);
  app.use('/api/couple', coupleRouter);
  app.use('/api/proposals', proposalRouter);
  // Before the '/api'-mounted wallet/quest routers: their router-level requireCouple would otherwise
  // run for /api/finance too, and own cash flow must work without a couple.
  app.use('/api/finance', financeRouter);
  // Hidden friends space: no couple needed either. Stories and events first (more specific prefixes).
  app.use('/api/friends/stories', metricArea('friends.stories'), friendStoryRouter);
  app.use('/api/friends/events', metricArea('friends.events'), friendEventRouter);
  app.use('/api/friends/outings', metricArea('friends.outings'), friendOutingRouter);
  app.use('/api/friends', metricArea('friends'), friendsRouter);
  // No login at all (invite-link previews).
  app.use('/api/public', publicRouter);
  // Web Push (N4): login only, no couple (both spaces).
  app.use('/api/push', pushRouter);
  // DEV ONLY: run scheduler jobs on demand for smoke tests. Never mounted in production.
  if (!isProd) app.use('/api/dev-scheduler', devSchedulerRouter);
  // DEV ONLY: what the mock push adapter would have sent (PUSH_PROVIDER=mock, which production refuses).
  const mockPush = getMockPush();
  if (mockPush && !isProd) app.use('/api/dev-push', devPushRouter(mockPush));
  app.use('/api', walletRouter);
  app.use('/api', questRouter);
  app.use('/api/water', waterRouter);
  app.use('/api/market', marketRouter);
  app.use('/api/stories', storyRouter);
  app.use('/api/questions', questionRouter);
  app.use('/api/events', eventRouter);
  app.use('/api/letters', letterRouter);
  app.use('/api/nudges', nudgeRouter);
  app.use('/api/moods', moodRouter);
  app.use('/api/bucket', bucketRouter);
  app.use('/api/moments', momentRouter);
  app.use('/api/savings', savingsRouter);

  // 404 + error handling (must be last)
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
