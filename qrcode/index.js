// qrcode/index.js — 抖音码生成端点（POST /api/qrcode）
// 移植自微信版 wxacode 云函数（人物卡片上的小程序码）。
//
// 官方文档核实（获取小程序码）：
//   1. 取服务端凭证：POST https://open.douyin.com/oauth/client_token/
//   2. 生成码：POST https://open.douyin.com/api/apps/v1/qrcode/create/
//      header: access-token；body: { appid, app_name, path, width, is_circle_code, set_icon... }
//      返回二维码图片二进制的 base64 编码
// ⚠️ 待实测项：client_token 的确切请求字段（grant_type/client_key/client_secret）
//    以官方「获取 client_token」文档为准；首次部署时先用控制台「调试」功能打通。
'use strict';

const https = require('https');

const CLIENT_TOKEN_URL = 'https://open.douyin.com/oauth/client_token/';
const QRCODE_URL = 'https://open.douyin.com/api/apps/v1/qrcode/create/';

// token 缓存（client_token 有有效期，实例 Warm 期间复用）
let tokenCache = { token: '', expiresAt: 0 };

module.exports = async (params, context) => {
  try {
    const appid = process.env.APP_ID || process.env.TT_APPID || '';
    const secret = process.env.APP_SECRET || process.env.TT_APPSECRET || '';
    if (!appid || !secret) return fail('CONFIG', '云端未配置 APP_ID/APP_SECRET 环境变量');

    const accessToken = await getClientToken(appid, secret);
    if (!accessToken) return fail('UPSTREAM', '获取服务端凭证失败');

    const res = await httpsPostJson(QRCODE_URL, {
      appid,
      app_name: 'douyin',          // 生成抖音端可扫的码
      path: 'pages/index/index',   // 未发布版本可能无法带 path，失败时去 path 重试
      width: 280,
      set_icon: false
    }, accessToken);

    // 防御性解析：正常返回 base64 字符串；错误返回 { err_no, err_msg }
    const base64 = typeof res === 'string' ? res
      : (res && res.data && (res.data.image || res.data.base64 || res.data.qrcode)) || '';
    if (base64) {
      return { success: true, imageBase64: base64 };
    }

    // 带 path 失败（小程序未发布时常见）→ 不带 path 重试一次
    if (res && res.err_no) {
      const retry = await httpsPostJson(QRCODE_URL, {
        appid, app_name: 'douyin', width: 280, set_icon: false
      }, accessToken);
      const retryBase64 = typeof retry === 'string' ? retry
        : (retry && retry.data && (retry.data.image || retry.data.base64 || retry.data.qrcode)) || '';
      if (retryBase64) return { success: true, imageBase64: retryBase64 };
      return fail('QRCODE', `抖音码生成失败(${res.err_no}): ${res.err_msg || ''}`);
    }

    return fail('QRCODE', '未返回图片数据');
  } catch (e) {
    console.error('[qrcode] 生成失败:', e);
    return fail('QRCODE', e.message || '抖音码生成失败（未发布的小程序可能暂不可生成）');
  }
};

async function getClientToken(appid, secret) {
  const now = Date.now();
  if (tokenCache.token && now < tokenCache.expiresAt) return tokenCache.token;

  const res = await httpsPostJson(CLIENT_TOKEN_URL, {
    grant_type: 'client_credential',
    client_key: appid,
    client_secret: secret
  });
  const data = (res && res.data) || {};
  const token = data.access_token || '';
  const expiresIn = (data.expires_in || 7200) * 1000;
  if (token) {
    tokenCache = { token, expiresAt: now + expiresIn - 5 * 60 * 1000 }; // 提前 5 分钟过期
  }
  return token;
}

function httpsPostJson(url, payload, accessToken) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(payload);
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) };
    if (accessToken) headers['access-token'] = accessToken;
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers,
      timeout: 10000
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        try { resolve(JSON.parse(buf.toString('utf8'))); }
        catch (e) {
          // 二进制/纯文本响应直接透传（qrcode 接口可能返回原始 base64 文本）
          resolve(buf.toString('utf8'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.write(data);
    req.end();
  });
}

function fail(code, message) { return { success: false, code, message }; }
