const http   = require('http');
const https  = require('https');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;

// Supabase project — used to validate access tokens on the gated /api routes.
const SUPABASE_URL  = process.env.SUPABASE_URL  || 'https://fpjqkmjtwnllmndxydta.supabase.co';
const SUPABASE_ANON = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZwanFrbWp0d25sbG1uZHh5ZHRhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODk2ODkwNjksImV4cCI6MjEwNTI2NTA2OX0.Al3_zP8Xv-kWnrs6j8Ky90WwN_K0CQ5g6UFEBYpwR1A';

const types = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.ico':  'image/x-icon',
};

// ── Auth: validate Supabase access tokens and enforce an email allowlist ────────
// No new server secret: we ask Supabase's /auth/v1/user endpoint who a token belongs to
// (200 => valid, unexpired, signed by the project), then check the email against the allowlist.
const ALLOWED_EMAILS = new Set(
  (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean)
);

// Ask Supabase to resolve an access token to its user. Rejects on any non-200.
function supabaseUser(token) {
  return new Promise((resolve, reject) => {
    const u = new URL(SUPABASE_URL + '/auth/v1/user');
    const r = https.request(
      { hostname: u.hostname, path: u.pathname, method: 'GET',
        headers: { apikey: SUPABASE_ANON, Authorization: 'Bearer ' + token } },
      resp => {
        let d = '';
        resp.on('data', c => d += c);
        resp.on('end', () => {
          if (resp.statusCode !== 200) return reject(new Error('token rejected: ' + resp.statusCode));
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        });
      }
    );
    r.on('error', reject);
    r.end();
  });
}

// Resolve to the caller's email if their token is valid and allowlisted; else reject with a code.
async function authorize(req) {
  const m = (req.headers['authorization'] || '').match(/^Bearer (.+)$/);
  if (!m) throw Object.assign(new Error('sign-in required'), { code: 401 });
  let user;
  try { user = await supabaseUser(m[1]); }
  catch (e) { throw Object.assign(new Error('invalid token'), { code: 401 }); }
  const email = (user.email || '').toLowerCase();
  if (!email) throw Object.assign(new Error('unverified'), { code: 403 });
  if (!ALLOWED_EMAILS.has(email)) throw Object.assign(new Error('not allowlisted'), { code: 403 });
  return email;
}

function denyAuth(res, err) {
  const code = err.code || 401;
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: code === 403 ? 'This account is not authorized for MacroWorld.' : 'Sign-in required.' } }));
}

http.createServer((req, res) => {

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
      // Content-hash ETag: always revalidate (no-cache), but skip re-downloading unchanged files.
      const etag = '"' + crypto.createHash('sha1').update(data).digest('base64') + '"';
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': ct, 'Cache-Control': 'no-cache', 'ETag': etag });
      res.end(data);
    });
  };

  tryNext(candidates);
}).listen(PORT, () => console.log(`Macro Tracker running on port ${PORT}`));
