// common/db.js — 抖音云 MongoDB 组件适配层（所有云端点共用）
// 抖音云控制台启用 MongoDB 组件后，平台自动将连接信息注入环境变量
// （参考官方 koa demo：Redis 注入 REDIS_ADDRESS/USERNAME/PASSWORD 的命名规律）。
// ⚠️ 部署前请在抖音云控制台「组件管理」核对实际变量名，如不一致改下面 buildUri() 的映射即可。
'use strict';

const { MongoClient } = require('mongodb');

let _client = null;
let _db = null;

function buildUri() {
  // 已有完整连接串则直接用（也可以在控制台环境变量里直接配 MONGODB_URI）
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI;

  const addr = process.env.MONGODB_ADDRESS || process.env.MONGO_ADDRESS || '';
  const user = process.env.MONGODB_USERNAME || process.env.MONGO_USERNAME || '';
  const pwd = process.env.MONGODB_PASSWORD || process.env.MONGO_PASSWORD || '';

  if (!addr) {
    throw new Error('缺少 MongoDB 组件环境变量（MONGODB_ADDRESS/MONGODB_USERNAME/MONGODB_PASSWORD），请先在抖音云控制台启用 MongoDB 组件');
  }
  if (user && pwd) {
    return `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pwd)}@${addr}`;
  }
  return `mongodb://${addr}`;
}

/** 获取数据库句柄（连接复用，云函数实例 Warm 期间不重复建连） */
async function getDb() {
  if (_db) return _db;
  if (!_client) {
    _client = new MongoClient(buildUri(), { serverSelectionTimeoutMS: 5000, maxPoolSize: 5 });
    await _client.connect();
  }
  _db = _client.db(process.env.MONGODB_DB || 'soulmatch');
  return _db;
}

async function collection(name) {
  const db = await getDb();
  return db.collection(name);
}

module.exports = { getDb, collection };
