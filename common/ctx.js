// common/ctx.js — 请求上下文解析与登录态校验（所有云端点共用）
//
// ⚠️ 防幻觉红线：抖音云函数 (params, context) 的确切结构官方文档未给出完整示例，
//    此处按多种可能形态做防御性解析；首次部署调试时以实际打印为准，若字段路径
//    不同只需调整 parseRequest() 一个函数。
//
// 登录态设计（v2，无 DB 依赖）：
//   客户端 tt.login → /api/login 服务端调 jscode2session 换 openid →
//   签发 HMAC 自包含 token（payload: openid + 过期时间，7 天）→ 客户端存储并在
//   后续请求 header 携带 x-token；服务端验签即可取回 openid，无需查库。
//   背景：MongoDB 组件个人主体不可用、云数据库审核中，DB 持久化暂缺；
//   云数据库开通后可在 login 里补 users/sessions 落库（非必需）。
'use strict';

const crypto = require('crypto');

const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

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
  return (h['x-token'] || h['X-Token']
    || req.query.token || req.body.token || '').toString();
}

function tokenSecret() {
  // 优先专用密钥，其次复用 APP_SECRET（已在服务设置配置）
  const s = process.env.TOKEN_SECRET || process.env.APP_SECRET || '';
  if (!s) console.warn('[ctx] 未配置 TOKEN_SECRET/APP_SECRET，使用开发默认密钥（上线前必须配置）');
  return s || 'soulmatch-dev-secret-do-not-use-in-prod';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 签发自包含 token：payload.openid + exp，HMAC-SHA256 防篡改 */
function issueToken(openid) {
  const payload = b64url(JSON.stringify({ openid, exp: Date.now() + TOKEN_TTL }));
  const sig = b64url(crypto.createHmac('sha256', tokenSecret()).update(payload).digest());
  return `${payload}.${sig}`;
}

/**
 * 验签并解析 token。
 * 返回 { openid, token, tokenValid }：
 *   - 无 token → tokenValid=false（公开数据可正常返回）
 *   - 有 token 但验签失败/过期 → tokenValid=false（调用方返回 TOKEN_INVALID 让客户端重登）
 */
function resolveUser(req) {
  const token = getToken(req);
  if (!token) return { openid: '', token: '', tokenValid: false };
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return { openid: '', token, tokenValid: false };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expect = b64url(crypto.createHmac('sha256', tokenSecret()).update(payload).digest());
  // 常量时间比较防时序攻击
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { openid: '', token, tokenValid: false };
  }
  try {
    const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    if (!json.openid || !json.exp || json.exp < Date.now()) {
      return { openid: '', token, tokenValid: false };
    }
    return { openid: json.openid, token, tokenValid: true };
  } catch (e) {
    return { openid: '', token, tokenValid: false };
  }
}

module.exports = { parseRequest, resolveUser, issueToken };
