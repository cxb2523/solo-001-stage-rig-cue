// 零依赖静态文件 + JSON API 服务（仅使用 Node 内置模块）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeSchedule } from './engine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = path.join(rootDir, 'data');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf-8'));
}

function loadData() {
  return {
    rig: readJson(path.join(dataDir, 'rig.json')),
    cues: readJson(path.join(dataDir, 'cues.json'))
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(res, urlPath) {
  const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const filePath = path.normalize(path.join(publicDir, relative));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'application/octet-stream' });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  if (url.pathname === '/api/data' && req.method === 'GET') {
    try {
      sendJson(res, 200, loadData());
    } catch (err) {
      sendJson(res, 500, { error: err.message });
    }
    return;
  }

  // body: { order: [cueId, ...] } —— 顺序变了，时间点和冲突全部重算
  if (url.pathname === '/api/schedule' && req.method === 'POST') {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy();
    });
    req.on('end', () => {
      try {
        const { rig, cues } = loadData();
        const body = raw ? JSON.parse(raw) : {};
        const schedule = computeSchedule(rig, cues, Array.isArray(body.order) ? body.order : undefined);
        sendJson(res, 200, schedule);
      } catch (err) {
        sendJson(res, 400, { error: err.message });
      }
    });
    return;
  }

  if (url.pathname === '/api/health') {
    sendJson(res, 200, { ok: true, node: process.version });
    return;
  }

  // 前端直接复用与测试完全相同的引擎源码，避免两份计算逻辑。
  if (url.pathname === '/vendor/engine.js' && req.method === 'GET') {
    fs.readFile(path.join(rootDir, 'src', 'engine.js'), (err, content) => {
      if (err) {
        res.writeHead(404);
        res.end('engine not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
      res.end(content);
    });
    return;
  }

  serveStatic(res, url.pathname);
});

const port = Number(process.env.PORT ?? 8080);
server.listen(port, () => {
  console.log(`舞台吊杆 Cue 预演台已启动: http://localhost:${port}`);
  console.log('数据文件: data/rig.json, data/cues.json');
});
