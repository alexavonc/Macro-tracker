const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;

const types = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

http.createServer((req, res) => {
  const urlPath  = req.url === '/' ? 'index.html' : req.url;
  const ext      = path.extname(urlPath);
  const contentType = types[ext] || 'text/plain';

  // Try public/ first, then root (preserves backwards-compat with app.js/index.html at root)
  const candidates = [
    path.join(__dirname, 'public', urlPath),
    path.join(__dirname, urlPath),
    path.join(__dirname, 'index.html'),  // SPA fallback
  ];

  const tryNext = (list) => {
    if (!list.length) { res.writeHead(404); res.end('Not found'); return; }
    fs.readFile(list[0], (err, data) => {
      if (err) { tryNext(list.slice(1)); return; }
      const ct = list[0].endsWith('index.html') ? 'text/html' : contentType;
      res.writeHead(200, { 'Content-Type': ct });
      res.end(data);
    });
  };

  tryNext(candidates);
}).listen(PORT, () => console.log(`Macro Tracker running on port ${PORT}`));
