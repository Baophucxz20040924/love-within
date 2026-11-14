// Test-only preload. Never enable the MongoDB profiler or inspect query arguments.
'use strict';
const { AsyncLocalStorage } = require('node:async_hooks');
const { createRequire } = require('node:module');
const http = require('node:http');
const path = require('node:path');

if (process.env.NODE_ENV !== 'development' || process.env.PORT !== '4010' ||
    process.env.MONGODB_URI !== 'mongodb://127.0.0.1:27017/lookwithin_v12_perf' || !process.send) {
  throw new Error('QUERY_COUNTS_REQUIRES_OWNED_LOCAL_PERFORMANCE_CHILD');
}
const mongoose = createRequire(path.join(process.cwd(), 'package.json'))('mongoose');
const storage = new AsyncLocalStorage();
const routes = new Set(['/api/friends/notifications', '/api/friends/unread', '/api/friends/events', '/api/couple/pulse', '/api/savings']);
const methods = new Set(['find', 'findOne', 'countDocuments', 'estimatedDocumentCount', 'distinct', 'aggregate',
  'insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'bulkWrite']);
function count(_collection, method) {
  const current = storage.getStore();
  if (!current || current.closed) return;
  if (!methods.has(method) || current.total >= 1000) { current.valid = false; return; }
  current.total++;
  current.methods[method] = (current.methods[method] || 0) + 1;
}
// Mongoose invokes this before each collection operation; no arguments are retained.
mongoose.set('debug', count);
const emit = http.Server.prototype.emit;
let requests = 0;
http.Server.prototype.emit = function (event, ...args) {
  if (event !== 'request') return emit.call(this, event, ...args);
  const [req, res] = args;
  const route = (req.url || '').split('?', 1)[0];
  const rawSequence = req.headers['x-perf-query-sequence'];
  if (req.method !== 'GET' || !routes.has(route) || typeof rawSequence !== 'string' || !/^[1-9]\d{0,2}$/.test(rawSequence)) {
    return emit.call(this, event, ...args);
  }
  const sequence = Number(rawSequence);
  if (sequence > 512 || ++requests > 512) throw new Error('QUERY_COUNTS_REQUEST_BOUND');
  const current = { total: 0, methods: {}, valid: true, closed: false };
  let sent = false;
  const finish = completed => {
    if (sent) return;
    sent = true;
    current.closed = true;
    process.send({ type: 'perf-query-count', sequence, method: 'GET', route,
      total: current.total, methods: current.methods,
      valid: completed && current.valid && current.total > 0 && mongoose.get('debug') === count });
  };
  res.once('finish', () => finish(true));
  res.once('close', () => finish(false));
  return storage.run(current, () => emit.call(this, event, ...args));
};
