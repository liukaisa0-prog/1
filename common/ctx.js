// common/ctx.js — 请求上下文解析与登录态校验（所有云端点共用）
//
// ⚠️ 防幻觉红线：抖音云函数 (params, context) 的确切结构官方文档未给出完整示例，
//    此处按多种可能形态做防御性解析；首次部署调试时以实际打印为准，若字段路径
//    不同只需调整 parseRequest() 一个函数。
//
// 登录态设计：客户端 tt.login → /api/login 换 token（写入 sessions 集合，7 天有效），
// 后续所有请求 header 携带 x-token；服务端用 token 换 openid（等价微信云函数 getWXContext）。
'use strict';

const crypto = require('crypto');
const { collection } = require('./db');

/** 解析请求：兼容 body 直接平铺 / params.body / params.query 等形态 */
function parseRequest(params, context) {
  const p = params || {};
  const body = (p.body && typeof p.body === 'object') ? p.body : p;
  const query = p.query || {};
  const headers = p.headers || p.header
    || (context && (context.headers || context.header)) || {};
  return { body, query, headers };
}

/** 从请求中提取 token（header 优先，兼容 query/body 便于调试） */
function getToken(req) {
  const h = req.headers || {};
  return (h['x-token'] || h['X-Token'] || h['x-token'.toUpperCase()]
    || req.query.token || req.body.token || '').toString();
}

/**
 * 解析当前用户身份。
 * 返回 { openid, token, tokenValid }：
 *   - 无 token → tokenValid=false（公开数据可正常返回）
 *   - 有 token 但查不到会话 → tokenValid=false（调用方返回 TOKEN_INVALID 让客户端重登）
 */
async function resolveUser(req) {
  const token = getToken(req);
  if (!token) return { openid: '', token: '', tokenValid: false };
  try {
    const sessions = await collection('sessions');
    const s = await sessions.findOne({ token, expires_at: { $gt: Date.now() } });
    if (s) return { openid: s.openid || '', token, tokenValid: true };
  } catch (e) {
    console.warn('[ctx] 会话查询失败:', e.message);
  }
  return { openid: '', token, tokenValid: false };
}

/** 生成登录态 token */
function issueToken() {
  return crypto.randomBytes(24).toString('hex');
}

module.exports = { parseRequest, resolveUser, issueToken };
