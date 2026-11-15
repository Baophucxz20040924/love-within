'use strict';
// Test-only. Install before importing ANY application model or connecting. Never use in production.
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const URI = 'mongodb://127.0.0.1:27017/lookwithin_dev';

function install(mongoose) {
  assert.equal(mongoose.connection.readyState, 0);
  assert.equal(Object.keys(mongoose.models).length, 0, 'namespace must be installed before any model');
  assert.equal(mongoose.connections.length, 1);
  const prefix = `verify_wallet_${randomBytes(12).toString('hex')}_`;
  const assigned = new Map();
  let sealed = false;
  const created = new Set();
  mongoose.set('autoIndex', false);
  mongoose.set('autoCreate', false);
  const target = name => {
    assert.equal(typeof name, 'string');
    assert.match(name, /^[A-Za-z][A-Za-z0-9_]*$/);
    const collection = `${prefix}${name.toLowerCase()}`;
    assert.ok(![...assigned].some(([other, value]) => other !== name && value === collection), 'model name collision');
    return collection;
  };
  const originalModel = mongoose.model;
  mongoose.model = function(name, schema, collection, options) {
    if (arguments.length === 1) return originalModel.call(mongoose, name);
    if (!schema || typeof schema === 'string' || !schema.instanceOfSchema) throw Error('Unexpected model registration');
    if (sealed && !assigned.has(name)) throw Error('Late model registration forbidden');
    if (sealed && mongoose.models[name] && mongoose.models[name].schema !== schema) throw Error('Late model replacement forbidden');
    const mapped = target(name);
    if (collection && collection !== mapped) throw Error('Explicit collection override forbidden');
    schema.set('autoIndex', false); schema.set('autoCreate', false);
    const existed = assigned.has(name);
    assigned.set(name, mapped);
    try { return originalModel.call(mongoose, name, schema, mapped, options); }
    catch (error) { if (!existed) assigned.delete(name); throw error; }
  };
  const connection = mongoose.connection;
  // No second connection or direct connection.model registration can escape the mapping.
  mongoose.createConnection = () => { throw Error('Additional connections forbidden'); };
  connection.useDb = () => { throw Error('Database switching forbidden'); };
  connection.model = function(name, schema, collection, options) {
    if (arguments.length === 1) return mongoose.model(name);
    return mongoose.model(name, schema, collection, options);
  };
  const originalCollection = connection.collection;
  connection.collection = function(name, options) {
    if (![...assigned.values()].includes(name)) throw Error('Unmapped collection forbidden');
    return originalCollection.call(this, name, options);
  };
  const originalConnect = mongoose.connect;
  mongoose.connect = function(uri, options = {}) {
    assert.equal(uri, URI, 'only the exact local verification database is allowed');
    return originalConnect.call(mongoose, URI, { ...options, autoIndex: false, autoCreate: false });
  };
  mongoose.Model.syncIndexes = async () => { throw Error('syncIndexes forbidden in verification'); };
  function verify() {
    assert.equal(mongoose.connections.length, 1);
    const models = Object.values(mongoose.models);
    assert.ok(models.length > 0);
    assert.equal(models.length, assigned.size);
    for (const model of models) {
      assert.equal(model.db, connection);
      assert.equal(model.collection.name, assigned.get(model.modelName));
      assert.equal(model.schema.options.autoIndex, false);
      assert.equal(model.schema.options.autoCreate, false);
    }
    return models;
  }
  function seal() {
    const models = verify();
    sealed = true;
    return models;
  }
  async function prepare() {
    const models = seal();
    assert.equal(connection.name, 'lookwithin_dev');
    // Fail closed in the astronomically unlikely event of a random-prefix collision.
    const existing = await connection.db.listCollections({}, { nameOnly: true }).toArray();
    assert.ok(existing.every(row => !row.name.startsWith(prefix)), 'verification prefix already exists');
    for (const model of models) {
      verify();
      // Driver createCollection propagates NamespaceExists; never adopt an existing collection.
      await connection.db.createCollection(model.collection.name);
      created.add(model.collection.name);
      await model.createIndexes(); // never sync/drop indexes, and only on verified fresh names
    }
    verify();
    return models;
  }
  async function cleanup() {
    assert.equal(connection.name, 'lookwithin_dev');
    verify();
    // Only exact names generated for this process; never drop by pattern or touch existing collections.
    for (const name of created) {
      assert.ok(name.startsWith(prefix));
      await connection.db.dropCollection(name).catch(err => { if (err.codeName !== 'NamespaceNotFound' && err.code !== 26) throw err; });
    }
  }
  return { prefix, verify, seal, prepare, cleanup, URI };
}
module.exports = { install, URI };
