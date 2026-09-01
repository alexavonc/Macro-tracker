const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

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

// ── Auth: verify Firebase ID tokens (RS256) and enforce an email allowlist ──────
// No external deps and no service-account secret: Firebase ID tokens are RS256 JWTs
// signed by Google, verifiable against Google's public x509 certs + standard claims.
const PROJECT_ID = FIREBASE_AUTH_DOMAIN.replace('.firebaseapp.com', '');
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

let googleKeys = null, googleKeysExp = 0;
function fetchGoogleKeys() {
  if (googleKeys && Date.now() < googleKeysExp) return Promise.resolve(googleKeys);
  return new Promise((resolve, reject) => {
    https.get('https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com', r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          googleKeys = JSON.parse(d);
          const m = (r.headers['cache-control'] || '').match(/max-age=(\d+)/);
          googleKeysExp = Date.now() + (m ? parseInt(m[1], 10) : 3600) * 1000;
          resolve(googleKeys);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

const b64url     = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const b64urlJson = s => JSON.parse(b64url(s).toString('utf8'));

async function verifyIdToken(token) {
  const p = String(token).split('.');
  if (p.length !== 3) throw new Error('malformed');
  const header = b64urlJson(p[0]), payload = b64urlJson(p[1]);
  if (header.alg !== 'RS256' || !header.kid) throw new Error('bad header');
  const cert = (await fetchGoogleKeys())[header.kid];
  if (!cert) throw new Error('unknown kid');
  const pub = new crypto.X509Certificate(cert).publicKey;
  if (!crypto.verify('RSA-SHA256', Buffer.from(p[0] + '.' + p[1]), pub, b64url(p[2]))) throw new Error('bad signature');
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error('expired');
  if (payload.aud !== PROJECT_ID) throw new Error('bad aud');
  if (payload.iss !== 'https://securetoken.google.com/' + PROJECT_ID) throw new Error('bad iss');
  if (!payload.sub) throw new Error('no sub');
  return payload;
}

// Resolve to the caller's email if their verified, allowlisted token checks out; else reject with a code.
async function authorize(req) {
  const m = (req.headers['authorization'] || '').match(/^Bearer (.+)$/);
  if (!m) throw Object.assign(new Error('sign-in required'), { code: 401 });
  let payload;
  try { payload = await verifyIdToken(m[1]); }
  catch (e) { throw Object.assign(new Error('invalid token'), { code: 401 }); }
  const email = (payload.email || '').toLowerCase();
  if (!payload.email_verified || !email) throw Object.assign(new Error('unverified'), { code: 403 });
  if (!ALLOWED_EMAILS.has(email)) throw Object.assign(new Error('not allowlisted'), { code: 403 });
  return email;
}

function denyAuth(res, err) {
  const code = err.code || 401;
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: code === 403 ? 'This account is not authorized for MacroWorld.' : 'Sign-in required.' } }));
}

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

  // Client gate: verify token + allowlist, return the email or 401/403.
  if (req.url === '/api/authorize' && req.method === 'POST') {
    authorize(req)
      .then(email => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, email })); })
      .catch(err => denyAuth(res, err));
    return;
  }

  // Proxy the Anthropic Messages API server-side so the API key never reaches the browser.
  // Gated: only a verified, allowlisted user may spend the key.
  if (req.url === '/api/anthropic' && req.method === 'POST') {
    authorize(req).then(() => {
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
    }).catch(err => denyAuth(res, err));
    return;
  }

  // Proxy OpenAI image edits (gpt-image-1) server-side so that key never reaches the browser.
  // Gated: only a verified, allowlisted user may spend the (expensive) image key.
  if (req.url === '/api/openai-image' && req.method === 'POST') {
    authorize(req).then(() => {
      const key = process.env.OPENAI_API_KEY;
      if (!key) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Server is missing OPENAI_API_KEY (set it in the server environment / .env).' } }));
        return;
      }
      const chunks = [];
      let size = 0;
      req.on('data', chunk => {
        size += chunk.length;
        if (size > 25 * 1024 * 1024) { req.destroy(); return; }  // 25MB cap
        chunks.push(chunk);
      });
      req.on('end', () => {
        const payload = Buffer.concat(chunks);
        const upstream = https.request(
          {
            hostname: 'api.openai.com',
            path: '/v1/images/edits',
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': req.headers['content-type'],  // preserve multipart boundary
              'Content-Length': payload.length,
            },
          },
          upRes => {
            res.writeHead(upRes.statusCode, { 'Content-Type': 'application/json' });
            upRes.pipe(res);
          }
        );
        upstream.on('error', e => {
          console.error('[openai image proxy]', e.message);
          res.writeHead(502, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Upstream request to OpenAI failed.' } }));
        });
        upstream.end(payload);
      });
    }).catch(err => denyAuth(res, err));
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
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
      res.end(data);
    });
  };

  tryNext(candidates);
}).listen(PORT, () => console.log(`Macro Tracker running on port ${PORT}`));
