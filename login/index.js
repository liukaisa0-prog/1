// login/index.js — 登录端点（POST /api/login）
// 链路：tt.login 取 code+anonymous_code → 服务端调官方 jscode2session 换 openid →
//       users 集合 upsert → 签发自建 token（sessions 集合，7 天）→ 返回 {token, openid}
//
// 官方文档核实（code2Session）：
//   POST https://developer.toutiao.com/api/apps/v2/jscode2session
//   body: { appid, secret, code, anonymous_code }（code 与 anonymous_code 至少一个）
//   返回: openid / anonymous_openid / session_key / unionid
//   权限：个人开发者可用
//
// ⚠️ 安全红线：APP_ID / APP_SECRET 只能存在抖音云环境变量（控制台 → 云服务 → 环境变量），
//    绝不能写进代码或下发给前端；session_key 不落库不下发（本设计不使用它）。
'use strict';

const https = require('https');
const { collection } = require('../common/db'); // DB 可选：云数据库开通后启用
const { parseRequest, resolveUser, issueToken } = require('../common/ctx');

const JSCODE2SESSION_URL = 'https://developer.toutiao.com/api/apps/v2/jscode2session';
const TOKEN_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

module.exports = async (params, context) => {
  const req = parseRequest(params, context);
  const { code, anonymous_code: anonymousCode } = req.body;

  // 已有有效 token 直接续期返回，避免每次进页都消耗 code
  const existing = await resolveUser(req);
  if (existing.tokenValid && existing.openid) {
    return ok({ token: existing.token, openid: existing.openid, renewed: true });
  }

  if (!code && !anonymousCode) {
    return fail('PARAM', '缺少 code / anonymous_code');
  }

  const appid = process.env.APP_ID || process.env.TT_APPID || '';
  const secret = process.env.APP_SECRET || process.env.TT_APPSECRET || '';
  if (!appid || !secret) {
    return fail('CONFIG', '云端未配置 APP_ID/APP_SECRET 环境变量');
  }

  let session;
  try {
    session = await httpsPostJson(JSCODE2SESSION_URL, {
      appid,
      secret,
      code: code || '',
      anonymous_code: anonymousCode || ''
    });
  } catch (e) {
    console.error('[login] jscode2session 请求失败:', e.message);
    return fail('UPSTREAM', '登录服务暂不可用，请稍后重试');
  }

  // v2 接口返回可能是 {err_no, err_msg, data:{openid...}} 或平铺，防御性解析
  const payload = (session && session.data) ? session.data : session;
  const errNo = session && session.err_no;
  if (errNo && errNo !== 0) {
    return fail('LOGIN', `登录凭证校验失败(${errNo}): ${session.err_msg || ''}`);
  }

  const identity = payload.openid || payload.anonymous_openid || '';
  if (!identity) {
    return fail('LOGIN', '未取到用户身份（openid/anonymous_openid 均为空）');
  }
  const unionid = payload.unionid || '';

  // v2：DB 持久化为可选（MongoDB 组件个人主体不可用、云数据库审核中）。
  // 云数据库开通后在这里补 users upsert / sessions 落库即可，当前静默跳过。
  try {
    const users = await collection('users');
    await users.updateOne(
      { openid: identity },
      { $set: { last_seen: Date.now() }, $setOnInsert: { openid: identity, unionid, created_at: Date.now() } },
      { upsert: true }
    );
  } catch (e) {
    console.warn('[login] users 落库跳过（DB 未启用）:', e.message);
  }

  // 签发 HMAC 自包含 token（验签无需查库，7 天有效）
  const token = issueToken(identity);
  return ok({ token, openid: identity });
};

function httpsPostJson(url, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) },
      timeout: 10000
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('响应非 JSON: ' + buf.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.write(data);
    req.end();
  });
}

function ok(data) { return { success: true, data }; }
function fail(code, message) { return { success: false, code, message }; }
