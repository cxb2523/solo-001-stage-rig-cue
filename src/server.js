'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function send(res, code, body, type) {
  res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8' });
  res.end(body);
}

function sendFile(res, file) {
  fs.readFile(file, (err, data) => {
    if (err) return send(res, 404, 'Not Found');
    send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/data') {
    try {
      const rig = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'rig.json'), 'utf8'));
      const cues = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cues.json'), 'utf8'));
      return send(res, 200, JSON.stringify({ rig, cues }), MIME['.json']);
    } catch (err) {
      return send(res, 500, '数据文件读取失败: ' + err.message);
    }
  }

  if (url.pathname === '/') return sendFile(res, path.join(PUBLIC_DIR, 'index.html'));
  // 计算内核同时供浏览器使用，保证前后端算法逐字节一致
  if (url.pathname === '/model.js') return sendFile(res, path.join(ROOT, 'src', 'model.js'));

  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR + path.sep) && file !== PUBLIC_DIR) {
    return send(res, 403, 'Forbidden');
  }
  return sendFile(res, file);
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`舞台吊杆预演台已启动: http://localhost:${PORT}`);
  });
}

module.exports = server;
