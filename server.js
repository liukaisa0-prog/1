// server.js — 心探抖音版云托管入口（Docker 容器进程）
// 你的服务形态是「云托管」（发布方式：Docker 镜像），因此需要一个 HTTP 服务进程
// 把 5 个端点函数挂到路由上；端点函数本身（login/match/stats/qrcode/init）保持不变。
//
// 请求处理约定（与 common/ctx.js 的 parseRequest 对齐）：
//   handler({ body: 解析后的JSON体, query: 查询串对象, headers: 请求头 }, context)
// 返回值（对象）→ JSON 响应；抛异常 → 500 INTERNAL。
//
// 日志全部走 stdout（抖音云要求：容器日志重定向到标准输出，在日志功能中查看）。
'use strict';

const http = require('http');

const routes = {
  '/api/login': require('./login'),
  '/api/match': require('./match'),
  '/api/stats': require('./stats'),
  '/api/qrcode': require('./qrcode'),
  '/api/init': require('./init')
};

const PORT = parseInt(process.env.PORT || '8000', 10); // ⚠️ 端口以抖音云托管实际注入的 PORT 为准

function parseQuery(url) {
  const q = {};
  try {
    const u = new URL(url, 'http://localhost');
    for (const [k, v] of u.searchParams) q[k] = v;
  } catch (e) { /* 忽略非法 query */ }
  return q;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 512 * 1024) { req.destroy(); resolve({}); return; } // 512KB 上限防滥用
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { resolve({ _raw: raw.slice(0, 2000) }); }
    });
    req.on('error', () => resolve({}));
  });
}

function send(res, statusCode, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const pathOnly = (req.url || '/').split('?')[0];
  const started = Date.now();
  try {
    // 健康检查（抖音云托管探活 & 前端诊断用）
    if (pathOnly === '/api/health' || pathOnly === '/') {
      return send(res, 200, { success: true, service: 'soul-match-douyin', time: Date.now() });
    }
    const handler = routes[pathOnly];
    if (!handler) {
      return send(res, 404, { success: false, code: 'NOT_FOUND', message: `未知端点: ${pathOnly}` });
    }
    const body = await readBody(req);
    const query = parseQuery(req.url);
    const params = { body, query, headers: req.headers };
    const result = await handler(params, { method: req.method, headers: req.headers });
    console.log(`[access] ${req.method} ${pathOnly} ${Date.now() - started}ms ok`);
    return send(res, 200, result || { success: false, code: 'EMPTY', message: '端点未返回内容' });
  } catch (e) {
    console.error(`[error] ${req.method} ${pathOnly}:`, e && e.stack || e);
    return send(res, 500, { success: false, code: 'INTERNAL', message: '服务开小差了，请稍后重试' });
  }
});

server.listen(PORT, () => {
  console.log(`[soul-match-douyin] cloud server listening on :${PORT}`);
  console.log(`[soul-match-douyin] endpoints: ${Object.keys(routes).join(', ')} (+ /api/health)`);
});
