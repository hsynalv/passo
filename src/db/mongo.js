const { MongoClient } = require('mongodb');
const cfg = require('../config');
const logger = require('../utils/logger');

let client = null;
let db = null;
let connectPromise = null;

function isMongoConfigured() {
  return !!String(cfg.MONGODB_URI || '').trim();
}

async function connectMongo() {
  if (db) return db;
  if (connectPromise) return connectPromise;
  if (!isMongoConfigured()) {
    logger.warn('MongoDB bağlantısı atlandı: MONGODB_URI tanımlı değil');
    return null;
  }

  connectPromise = (async () => {
    const uri = String(cfg.MONGODB_URI).trim();
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: cfg.MONGODB_CONNECT_TIMEOUT_MS,
      connectTimeoutMS: cfg.MONGODB_CONNECT_TIMEOUT_MS,
    });
    await client.connect();
    db = client.db(cfg.MONGODB_DB_NAME);
    logger.info('MongoDB bağlantısı kuruldu', { dbName: cfg.MONGODB_DB_NAME });
    return db;
  })();

  try {
    return await connectPromise;
  } catch (error) {
    connectPromise = null;
    db = null;
    client = null;
    logger.errorSafe('MongoDB bağlantısı kurulamadı', error);
    throw error;
  }
}

function getDb() {
  if (!db) throw new Error('MONGODB_NOT_CONNECTED');
  return db;
}

function getCollection(name) {
  return getDb().collection(name);
}

async function closeMongo() {
  if (!client) return;
  try {
    await client.close();
  } finally {
    client = null;
    db = null;
    connectPromise = null;
  }
}

module.exports = {
  connectMongo,
  closeMongo,
  getDb,
  getCollection,
  isMongoConfigured,
};
