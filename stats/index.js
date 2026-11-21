// stats/index.js — 统计端点（POST /api/stats）
// 移植自微信版 stats 云函数：全局概览数据，给首页「已有 X 人完成测试」使用。
// 约定：直接返回顶层 totalTests/totalUsers（前端 index.js 读取顶层字段）。
'use strict';

const { collection } = require('../common/db');
const { parseRequest } = require('../common/ctx');

// 轻量缓存：实例 Warm 期间复用，最长 60s，减少 count 压力（best-effort，不影响正确性）
let cache = { at: 0, data: null };
const CACHE_TTL = 60 * 1000;

module.exports = async (params, context) => {
  const req = parseRequest(params, context);
  const action = (req.body && req.body.action) || (req.query && req.query.action);

  if (action === 'getOverview') {
    return await getOverview();
  }
  // 未知 action 时返回空概览，不抛错（首页静默降级为 0）
  return { success: false, code: 'PARAM', message: `未知 action: ${action}`, totalTests: 0 };
};

/** 全局概览：真实参与人数（来自 test_records 集合，绝不虚构） */
async function getOverview() {
  const now = Date.now();
  if (cache.data && (now - cache.at) < CACHE_TTL) {
    return { ...cache.data, cached: true };
  }

  let totalTests = 0;
  let totalUsers = 0;
  try {
    const col = await collection('test_records');
    totalTests = await col.countDocuments({});
  } catch (e) {
    console.warn('[stats] test_records 计数失败:', e.message);
  }

  try {
    const col = await collection('users');
    totalUsers = await col.countDocuments({});
  } catch (e) {
    console.warn('[stats] users 计数失败:', e.message);
  }

  const data = { success: true, totalTests, totalUsers };
  cache = { at: now, data };
  return data;
}
