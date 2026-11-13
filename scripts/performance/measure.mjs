import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const save = (dir, name, value) => fs.writeFile(path.join(dir, name), JSON.stringify(value, null, 2));
function check(ok, code) { if (!ok) { const e = new Error(code); e.harnessCode = code; throw e; } }
const percentile = (values, p) => [...values].sort((a,b) => a-b)[Math.max(0, Math.ceil(values.length*p)-1)];

async function fixture(db, ObjectId, previous) {
  if (previous) {
    const f = JSON.parse(await fs.readFile(previous, 'utf8'));
    check(f.version === 1 && /^v12-perf-/.test(f.tag) && f.database === 'lookwithin_v12_perf', 'INVALID_FIXTURE_MANIFEST');
    for (const [collection, count] of Object.entries(f.counts)) check(await db.collection(collection).countDocuments({ perfTag: f.tag }) === count, `FIXTURE_COUNT_${collection}`);
    return f;
  }
  const tag = `v12-perf-${randomUUID()}`;
  const now = new Date();
  const readers = [new ObjectId(), new ObjectId()];
  const creators = Array.from({ length: 20 }, () => new ObjectId());
  const coupleId = new ObjectId();
  const goals = Array.from({ length: 100 }, () => new ObjectId());
  const events = Array.from({ length: 40 }, () => new ObjectId());
  const counts = {};
  async function insert(collection, rows) {
    check(rows.every(r => r._id), 'EXPLICIT_SYNTHETIC_IDS_REQUIRED');
    await db.collection(collection).insertMany(rows.map(r => ({ createdAt: now, updatedAt: now, ...r, perfTag: tag })), { ordered: true });
    counts[collection] = rows.length;
  }
  // Mongoose's connection/driver, insert-only new IDs and an explicit synthetic tag. No delete/update/drop.
  await insert('users', [...readers, ...creators].map((id, i) => ({ _id: id, email: `${tag}-${i}@example.invalid`, passwordHash: 'synthetic-non-login-account',
    displayName: `Performance user ${i}`, coupleId: i < 2 ? coupleId : null, timezone: 'Asia/Ho_Chi_Minh', friendsJoinedAt: now,
    friendsSearchName: `performance user ${i}`, avatarKey: null, friendsBio: '', friendsNotifSeenAt: null, storiesSeenAt: null,
    marketSeenAt: null, financeVisibility: 'private', aiFinanceConsentAt: null })));
  await insert('couples', [{ _id: coupleId, memberIds: readers, anniversaryDate: null, level: 1, exp: 0, timezone: 'Asia/Ho_Chi_Minh', status: 'active', pinnedSavingsGoalId: goals[0], savingsWriteToken: null, savingsWriteStartedAt: null }]);
  await insert('friendships', readers.flatMap(reader => creators.map(creator => ({ _id: new ObjectId(), requesterId: creator, recipientId: reader,
    pairKey: [String(reader), String(creator)].sort().join(':'), status: 'accepted', acceptedAt: now }))));
  await insert('friendevents', events.map((id, i) => ({ _id: id, creatorId: creators[i % 20], title: `Synthetic meetup ${i}`, startAt: new Date(+now + (i+1)*86400000),
    endAt: null, pastAt: new Date(+now + (i+1)*86400000 + 21600000), place: 'Synthetic location', mapUrl: null, description: 'Synthetic representative event description. '.repeat(8),
    cover: null, inviteeIds: readers, rsvps: {}, status: 'active', cancelledAt: null, commentCount: 0, editedAt: null, hiddenByReportsAt: null, deletedAt: null })));
  await insert('friendnotifications', readers.flatMap(reader => Array.from({ length: 160 }, (_, i) => ({ _id: new ObjectId(), userId: reader,
    type: i % 2 ? 'event_invite' : 'event_reminder', entityId: events[i % 40], groupKey: null,
    actorIds: i % 2 ? [creators[i % 20]] : [], recentActorIds: i % 2 ? [creators[i % 20]] : [], readAt: null,
    updatedAt: new Date(+now - i*1000) }))));
  await insert('savingsgoals', goals.map((id, i) => ({ _id: id, coupleId, title: `Synthetic goal ${String(i).padStart(3, '0')}`, emoji: '*', targetVnd: 1000000,
    dueOn: null, status: 'active', reachedAt: null, createdBy: readers[i % 2], version: 1, appliedProposalIds: [], createdAt: new Date(+now-i*1000) })));
  const day = now.toISOString().slice(0, 10);
  await insert('savingsentries', goals.flatMap(goalId => [100000, 50000, -10000, 900000].map((amountVnd, i) => ({ _id: new ObjectId(), coupleId, goalId,
    userId: readers[i % 2], amountVnd, occurredOn: day, note: 'Synthetic benchmark contribution', source: 'manual', bankTxnId: null,
    bankFingerprint: null, operationKeyHash: null, operationPayloadHash: null, deletedAt: i === 3 ? now : null }))));
  await insert('coupleevents', Array.from({ length: 20 }, (_, i) => ({ _id: new ObjectId(), coupleId, title: `Synthetic countdown ${i}`, emoji: '*', kind: 'other',
    personId: null, date: new Date(+now+(i+1)*86400000).toISOString().slice(0,10), time: null, repeat: 'none', note: '', remind: false,
    createdBy: readers[0], updatedBy: readers[0], deletedAt: null })));
  return { version: 1, tag, database: 'lookwithin_v12_perf', createdAt: now.toISOString(), readers: readers.map(String), creators: creators.map(String),
    coupleId: String(coupleId), goalIds: goals.map(String), eventIds: events.map(String), counts,
    expected: { goals: 100, balancePerGoalVnd: 140000, allGoalsTotalVnd: 14000000, contributionByReaderVnd: [90000, 50000], notifications: 99, events: 40 },
    notes: '100 goals, 400 entries (100 soft-deleted), 20 event creators, 40 events, 160 notification candidates per reader. Synthetic records retained; no unknown records removed.' };
}

function executionSummary(explain) {
  const cursor = explain.stages?.find(s => s.$cursor)?.$cursor ?? explain;
  const stats = cursor.executionStats ?? {};
  const plan = cursor.queryPlanner?.winningPlan;
  const stages = new Set(); const indexes = new Set();
  function visit(o) {
    if (!o || typeof o !== 'object') return;
    if (o.stage) stages.add(o.stage);
    if (o.indexName) indexes.add(o.indexName);
    for (const v of Object.values(o)) if (v && typeof v === 'object') visit(v);
  }
  visit(plan);
  return { nReturned: stats.nReturned ?? null, totalDocsExamined: stats.totalDocsExamined ?? null,
    totalKeysExamined: stats.totalKeysExamined ?? null, executionTimeMillis: stats.executionTimeMillis ?? null,
    stages: [...stages], indexes: [...indexes] };
}

export async function run(ctx) {
  const mongoose = ctx.require('mongoose');
  const conn = await mongoose.createConnection(ctx.mongoUri, { maxPoolSize: 2, serverSelectionTimeoutMS: 5000, socketTimeoutMS: 15000 }).asPromise();
  try {
    check(conn.name === 'lookwithin_v12_perf' && ['127.0.0.1','localhost'].includes(conn.host), 'UNSAFE_DATABASE');
    const db = conn.db;
    try {
      const info = await db.admin().command({ buildInfo: 1 }, { maxTimeMS: 3000 });
      ctx.environment.mongo = { version: info.version, status: 'observed now via buildInfo' };
    } catch {
      ctx.environment.mongo = { version: null, status: 'unavailable; no version inferred' };
    }
    await save(ctx.out, 'environment.json', ctx.environment);
    const before = ctx.baselineDir ? JSON.parse(await fs.readFile(path.join(ctx.baselineDir, 'report.json'), 'utf8')) : null;
    const ObjectId = mongoose.Types.ObjectId;
    const f = await fixture(db, ObjectId, ctx.fixturePath);
    if (before) check(before.measured === true && before.fixtureTag === f.tag &&
      before.methodology.repetitions === 3 && JSON.stringify(before.methodology.concurrency) === '[1,4]' &&
      before.methodology.requestsPerEndpointPerRepetition === 4 && before.methodology.warmupsPerEndpoint === 2, 'BASELINE_METHOD_OR_FIXTURE_MISMATCH');
    await save(ctx.out, 'fixture.json', f);
    const gate = () => check(Date.now() < ctx.deadline, 'OVERALL_DURATION_STOP');
    const tokens = f.readers.map(ctx.tokenFor);
    const requests = []; const samples = [];
    // Sliding-window safeguards include warmup and correctness reads. Independent users, never disabled limits.
    const userTimes = tokens.map(() => []); const edgeTimes = [];
    let ticket = Promise.resolve();
    async function budget(user) {
      const prior = ticket; let release; ticket = new Promise(resolve => { release = resolve; });
      await prior;
      try {
        for (;;) {
          gate();
          const now = Date.now();
          while (edgeTimes[0] <= now-60000) edgeTimes.shift();
          while (userTimes[user][0] <= now-60000) userTimes[user].shift();
          const wait = Math.max(edgeTimes.length >= 480 ? edgeTimes[0]+60010-now : 0, userTimes[user].length >= 100 ? userTimes[user][0]+60010-now : 0);
          if (wait <= 0) { edgeTimes.push(now); userTimes[user].push(now); break; }
          await sleep(wait);
        }
      } finally { release(); }
    }
    let querySequence = 0;
    async function get(route, user = 0, purpose = 'check') {
      await budget(user);
      gate();
      const sequence = ctx.queryCountFor ? ++querySequence : null;
      check(sequence === null || sequence <= 512, 'QUERY_COUNT_REQUEST_BOUND');
      const headers = { authorization: `Bearer ${tokens[user]}` };
      if (sequence !== null) headers['x-perf-query-sequence'] = String(sequence);
      const started = performance.now();
      const r = await fetch(`${ctx.base}${route}`, { headers, signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      const metric = { purpose, route: route.split('?')[0], user, status: r.status, latencyMs: +(performance.now()-started).toFixed(3), bytes: Buffer.byteLength(text) };
      requests.push(metric);
      check(r.ok, `HTTP_${r.status}_${metric.route.replaceAll('/', '_')}`);
      if (sequence !== null) metric.queryCount = await ctx.queryCountFor(sequence, metric.route);
      const data = JSON.parse(text).data;
      metric.items = data?.items?.length ?? null;
      return { data, metric };
    }
    async function monitor(label) {
      const r = await fetch(`${ctx.base}/api/metrics`, { signal: AbortSignal.timeout(3000) });
      const { data } = await r.json();
      check(r.ok && data.pid === ctx.apiPid, 'METRICS_OWNER_MISMATCH');
      samples.push({ label, ...data });
      gate();
      check(data.memory.rssMb < 768, 'RSS_SAFETY_STOP');
      const lag = data.eventLoop?.p99LagMs;
      check(Number.isFinite(lag), 'EVENT_LOOP_METRIC_UNAVAILABLE');
      check(lag < 200, 'EVENT_LOOP_SAFETY_STOP');
      check(data.counters.errors5xx === 0 && data.counters.rateLimited === 0, 'SERVER_ERRORS_OR_THROTTLING');
    }
    const endpoints = [
      ['notificationFeed', '/api/friends/notifications'], ['unread', '/api/friends/unread'],
      ['eventList', '/api/friends/events?scope=upcoming'], ['pulse', '/api/couple/pulse'], ['savings', '/api/savings?limit=20'],
    ];
    await monitor('before-warmup');
    for (const [, route] of endpoints) for (let user = 0; user < 2; user++) await get(route, user, 'warmup');
    const runs = [];
    for (const concurrency of [1, 4]) {
      for (let repetition = 1; repetition <= 3; repetition++) {
        for (const [endpoint, route] of endpoints) {
          await monitor(`c${concurrency}-run${repetition}-${endpoint}`);
          const measured = [];
          const started = performance.now();
          for (let offset = 0; offset < 4; offset += concurrency) {
            await Promise.all(Array.from({ length: concurrency }, async (_, i) => {
              const { metric } = await get(route, (offset+i)%2, 'measured'); measured.push(metric);
            }));
          }
          const elapsedMs = performance.now()-started;
          runs.push({ endpoint, concurrency, repetition, requests: measured.length, elapsedMs: +elapsedMs.toFixed(3),
            throughputRps: +(measured.length*1000/elapsedMs).toFixed(2),
            p50Ms: percentile(measured.map(m => m.latencyMs), .5), p95Ms: percentile(measured.map(m => m.latencyMs), .95),
            bytes: measured.map(m => m.bytes), pageItems: measured.map(m => m.items), latenciesMs: measured.map(m => m.latencyMs),
            ...(ctx.queryCountFor ? { queryCounts: measured.map(m => m.queryCount) } : {}) });
        }
        await monitor(`c${concurrency}-run${repetition}`);
      }
    }
    const first = await get('/api/savings?limit=20');
    let page = first.data; const all = []; const pages = [];
    for (let n = 0; n < 12; n++) {
      pages.push(page.items.length); all.push(...page.items);
      if (!page.nextCursor) break;
      page = (await get(`/api/savings?limit=20&cursor=${encodeURIComponent(page.nextCursor)}`)).data;
    }
    check(all.length === 100 && new Set(all.map(g => g.id)).size === 100, 'SAVINGS_PAGINATION_COMPLETENESS');
    for (const goal of all) {
      check(goal.totalVnd === f.expected.balancePerGoalVnd, 'SAVINGS_BALANCE');
      check(goal.contributions.every(c => c.amountVnd === f.expected.contributionByReaderVnd[f.readers.indexOf(c.userId)]), 'SAVINGS_CONTRIBUTIONS');
    }
    const pulse = (await get('/api/couple/pulse')).data;
    check(pulse.savings?.totalVnd === f.expected.balancePerGoalVnd, 'PULSE_BALANCE');
    const unread = (await get('/api/friends/unread')).data;
    check(unread.notifications === 99, 'UNREAD_COUNT');
    const eventList = (await get('/api/friends/events?scope=upcoming')).data;
    check(eventList.items.length === 40, 'EVENT_LIST_COUNT');
    const feed = (await get('/api/friends/notifications')).data;
    check(feed.items.length === 20, 'NOTIFICATION_FEED_COUNT');
    const balanceRows = all.map(g => ({ id: g.id, totalVnd: g.totalVnd, contributions: [...g.contributions].sort((a,b) => a.userId.localeCompare(b.userId)) })).sort((a,b) => a.id.localeCompare(b.id));
    const correctness = { savings: { firstPageItems: first.data.items.length, firstPageBytes: first.metric.bytes, pages, totalGoals: all.length,
      totalVnd: all.reduce((sum,g) => sum+g.totalVnd, 0), balancePerGoalVnd: f.expected.balancePerGoalVnd,
      balanceDigest: createHash('sha256').update(JSON.stringify(balanceRows)).digest('hex'), balances: balanceRows },
      pulseBalanceVnd: pulse.savings.totalVnd, unread, eventItems: eventList.items.length, notificationFeedItems: feed.items.length };
    if (before) check(correctness.savings.balanceDigest === before.correctness.savings.balanceDigest, 'BASELINE_BALANCE_DIGEST_MISMATCH');
    // Explicit component-query explains, not a claim to instrument every API query.
    const coupleId = new ObjectId(f.coupleId); const userId = new ObjectId(f.readers[0]);
    const pageIds = first.data.items.map(g => new ObjectId(g.id));
    const explains = {};
    explains.notificationFeed = executionSummary(await db.collection('friendnotifications').find({ userId }).sort({ updatedAt: -1, _id: -1 }).limit(21).explain('executionStats'));
    const notifSource = await fs.readFile(path.join(ctx.backend, 'src/repositories/friendNotification.repository.ts'), 'utf8');
    const unreadCursor = db.collection('friendnotifications').find({ userId }).sort({ updatedAt: -1, _id: -1 }).limit(notifSource.includes('CANDIDATE_FIELDS') ? 501 : 500);
    if (notifSource.includes('CANDIDATE_FIELDS')) unreadCursor.project({ _id: 1, type: 1, entityId: 1, actorIds: 1, recentActorIds: 1, readAt: 1, updatedAt: 1 });
    explains.unreadCandidates = executionSummary(await unreadCursor.explain('executionStats'));
    explains.eventList = executionSummary(await db.collection('friendevents').find({ deletedAt: null, pastAt: { $gt: new Date() },
      $or: [{ creatorId: userId }, { inviteeIds: userId, creatorId: { $in: f.creators.map(id => new ObjectId(id)) }, hiddenByReportsAt: null }] }).sort({ startAt: 1, _id: 1 }).limit(50).explain('executionStats'));
    const goalQuery = db.collection('savingsgoals').find({ coupleId }).sort({ createdAt: -1, _id: -1 });
    if (first.data.nextCursor) goalQuery.limit(21);
    explains.savingsGoals = executionSummary(await goalQuery.explain('executionStats'));
    const totals = [{ $match: { coupleId, goalId: { $in: pageIds }, deletedAt: null } },
      { $group: { _id: { goalId: '$goalId', userId: '$userId' }, total: { $sum: '$amountVnd' } } }];
    explains.savingsPageTotals = executionSummary(await db.collection('savingsentries').aggregate(totals).explain('executionStats'));
    explains.pulsePinnedEntries = executionSummary(await db.collection('savingsentries').aggregate([
      { $match: { coupleId, goalId: new ObjectId(f.goalIds[0]), deletedAt: null } }, { $group: { _id: null, total: { $sum: '$amountVnd' } } },
    ]).explain('executionStats'));
    await monitor('complete');
    const summary = endpoints.flatMap(([endpoint]) => [1,4].map(concurrency => {
      const selected = runs.filter(r => r.endpoint === endpoint && r.concurrency === concurrency);
      const latencies = selected.flatMap(r => r.latenciesMs);
      return { endpoint, concurrency, requests: latencies.length, p50Ms: percentile(latencies, .5), p95Ms: percentile(latencies, .95),
        meanBytes: Math.round(selected.flatMap(r => r.bytes).reduce((a,b) => a+b, 0)/latencies.length), pageItems: selected[0].pageItems[0] };
    }));
    const instrumentation = ctx.environment.queryInstrumentation;
    const sameInstrumentation = before && (before.methodology.queryInstrumentation ?? 'none') === instrumentation;
    const queryCounts = ctx.queryCountFor ? {
      measured: true, unit: 'Mongoose collection operation invocations', instrumentation,
      scope: 'Exact debug callback invocations in each GET request async context before response finish; includes auth/middleware and populate calls. Counts are observed, never inferred from explains.',
      limits: 'Not MongoDB wire commands: excludes driver retries/getMore, raw-driver access, work outside request async context, startup/background work and operations after response finish. Five fixed routes only; outing detail remains unmeasured. Unknown methods, missing messages, zero totals or >1000 operations fail closed.',
      overhead: ctx.environment.instrumentationOverhead,
      rows: endpoints.flatMap(([endpoint]) => [1,4].map(concurrency => {
        const selected = runs.filter(r => r.endpoint === endpoint && r.concurrency === concurrency).flatMap(r => r.queryCounts);
        return { endpoint, method: 'GET', concurrency, requests: selected.length,
          counts: selected.map(s => s.total), min: Math.min(...selected.map(s => s.total)), max: Math.max(...selected.map(s => s.total)),
          total: selected.reduce((sum,s) => sum+s.total, 0), methods: selected.reduce((all,s) => {
            for (const [method,n] of Object.entries(s.methods)) all[method] = (all[method] || 0)+n;
            return all;
          }, {}) };
      })),
    } : { measured: false, actualApiDatabaseQueries: null, reason: 'Not instrumented; independent explains are NOT actual API query counts' };
    const report = { measured: true, phase: ctx.phase, measuredAt: new Date().toISOString(), sourceDigest: ctx.sourceDigest, fixtureTag: f.tag,
      methodology: { repetitions: 3, concurrency: [1,4], requestsPerEndpointPerRepetition: 4, warmupsPerEndpoint: 2,
        queryInstrumentation: instrumentation, timings: ctx.queryCountFor ? 'Instrumentation-only timings; do not compare against retained uninstrumented baseline or claim faster' : 'Uninstrumented timings',
        rateSafety: '100 reads/user/sliding 60s and 480 aggregate/minute; production limiters unchanged; two synthetic users',
        caveats: '12 latency samples per endpoint/concurrency: exploratory local results, not capacity or statistically robust p95. Shared workstation, warm DB, development tsx. Feed means notification feed. Pagination reduces work and response size; not equal-size savings payload comparison.',
        explains: 'Independent equivalent filter/sort/limit component queries. Savings totals explain simplifies recent contribution arithmetic; pinned explain measures entry scan, not entire pulse. docsExamined counts fetched documents, keysExamined index entries; they are not API query counts or response rows. Never enable DB profiler.' },
      safety: { overallDurationMs: 240000, hardExitGraceMs: 10000, eventLoopP99StopMs: 200,
        eventLoopGate: 'Polled before each endpoint group and after each repetition; not continuous monitoring',
        rssStopMb: 768, maxObservedRssMb: Math.max(...samples.map(s => s.memory.rssMb)), errors5xx: samples.at(-1).counters.errors5xx,
        rateLimited: samples.at(-1).counters.rateLimited, database: 'lookwithin_v12_perf', unknownDocumentsDeleted: 0 },
      comparison: before ? { baseline: ctx.baselineDir, sameFixture: true, sameRequestMethod: true,
        balanceDigestMatches: correctness.savings.balanceDigest === before.correctness.savings.balanceDigest,
        scope: 'Five existing endpoints only; outing detail has no before fixture and is not measured. Extra metrics polls change overhead slightly.',
        sameInstrumentation: !!sameInstrumentation,
        latencyComparisonSuppressed: !!ctx.queryCountFor || !sameInstrumentation,
        note: ctx.queryCountFor ? 'After-only operation counts; instrumented timings cannot establish speedup against retained latency baseline' : 'Latency rows require matching instrumentation mode',
        rows: !ctx.queryCountFor && sameInstrumentation ? summary.map(after => ({ before: before.summary.find(b => b.endpoint === after.endpoint && b.concurrency === after.concurrency), after })) : [] } : null,
      queryCounts,
      currentMetricAvailability: { http: samples.at(-1).http != null, operations: samples.at(-1).operations != null,
        note: 'Raw current snapshots retained below; absent historical fields remain absent. Read-only workload does not exercise savings locks.' },
      summary, correctness, explains, runs, metrics: samples, requests };
    await save(ctx.out, 'report.json', report);
    console.log(JSON.stringify({ measured: true, phase: ctx.phase, summary, savingsPages: pages, maxObservedRssMb: report.safety.maxObservedRssMb }));
  } finally { await conn.close(); }
}
