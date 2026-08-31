const http  = require('http');
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const PORT = process.env.PORT || 8080;

// Firebase project auth domain — proxy /__/ requests here so Safari's
// third-party cookie blocking doesn't break signInWithRedirect.
const FIREBASE_AUTH_DOMAIN = 'macrotracker-b2d17.firebaseapp.com';

const types = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

http.createServer((req, res) => {

  // Proxy Firebase auth handler so auth stays same-origin (fixes iOS Safari)
  if (req.url.startsWith('/__/')) {
    const headers = { ...req.headers, host: FIREBASE_AUTH_DOMAIN };
    delete headers['connection'];
    const proxyReq = https.request(
      { hostname: FIREBASE_AUTH_DOMAIN, path: req.url, method: req.method, headers },
      proxyRes => {
        const outHeaders = { ...proxyRes.headers };
        delete outHeaders['transfer-encoding'];
        res.writeHead(proxyRes.statusCode, outHeaders);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on('error', e => { console.error('[proxy]', e.message); res.writeHead(502); res.end(); });
    req.pipe(proxyReq);
    return;
  }

  // Proxy the Anthropic Messages API server-side so the API key never reaches the browser.
  // The client POSTs the same request body it used to send directly; the key is added here.
  if (req.url === '/api/anthropic' && req.method === 'POST') {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Server is missing ANTHROPIC_API_KEY (set it in the server environment / .env).' } }));
      return;
    }
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 8 * 1024 * 1024) req.destroy();  // 8MB cap — base64 images
    });
    req.on('end', () => {
      const payload = Buffer.from(body);
      const upstream = https.request(
        {
          hostname: 'api.anthropic.com',
          path: '/v1/messages',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': payload.length,
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
          },
        },
        upRes => {
          res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
          upRes.pipe(res);
        }
      );
      upstream.on('error', e => {
        console.error('[anthropic proxy]', e.message);
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream request to Anthropic failed.' } }));
      });
      upstream.end(payload);
    });
    return;
  }

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
