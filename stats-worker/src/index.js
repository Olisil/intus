// intus stats - a small Cloudflare Worker with a D1 database.
//
//   POST /collect                  anonymous visit summary from the viewer (no cookies, no IP stored)
//   GET  /auth/status              { setup: true } until the first admin account exists
//   POST /auth/setup               create the first admin (needs the SETUP_CODE secret)
//   POST /auth/login               email + password -> bearer token
//   GET  /api/me                   who am I
//   POST /api/me/password          change my password
//   GET  /api/tours                tours with visits (only the ones this account may see)
//   GET  /api/sessions?tour=&from=&to=&limit=&offset=     visit records for a tour
//   DELETE /api/sessions?tour=[&sid=]                     (admin) remove test visits
//   GET  /api/users | POST /api/users | DELETE /api/users?email= | POST /api/users/reset   (admin)

const TOUR_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const SID_RE = /^[A-Za-z0-9]{12,40}$/;
const MAX_BODY = 120_000;
const TOKEN_DAYS = 30;
const PBKDF2_ITER = 20_000;

let schemaReady = false;
async function schema(env) {
  if (schemaReady) return;
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sessions (
      sid TEXT PRIMARY KEY, tour TEXT NOT NULL, started INTEGER NOT NULL, updated INTEGER NOT NULL,
      dur REAL NOT NULL DEFAULT 0, device TEXT, country TEXT, data TEXT NOT NULL)`),
    env.DB.prepare('CREATE INDEX IF NOT EXISTS sessions_tour ON sessions (tour, started)'),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS users (
      email TEXT PRIMARY KEY, name TEXT, role TEXT NOT NULL, tours TEXT NOT NULL DEFAULT '[]',
      salt TEXT NOT NULL, hash TEXT NOT NULL, ver INTEGER NOT NULL DEFAULT 1, created INTEGER NOT NULL)`),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS login_fail (email TEXT PRIMARY KEY, count INTEGER NOT NULL, until INTEGER NOT NULL)'),
  ]);
  schemaReady = true;
}

// ------------------------------------------------------------------ helpers
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const randomString = (n = 16) => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const r = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(r, (x) => abc[x % abc.length]).join('');
};

function allowedOrigin(env, origin) {
  if (!origin) return null;
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return origin;
  if (/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return origin;  // the studio and local previews
  return null;
}

function cors(env, req) {
  const o = allowedOrigin(env, req.headers.get('Origin'));
  return o ? {
    'Access-Control-Allow-Origin': o, 'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS', 'Access-Control-Max-Age': '86400',
  } : {};
}

const json = (obj, status = 200, headers = {}) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
});

async function secret(env) {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = 'secret'").first();
  if (row) return row.value;
  const s = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('secret', ?)").bind(s).run();
  return (await env.DB.prepare("SELECT value FROM settings WHERE key = 'secret'").first()).value;
}

async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', enc.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', k, enc.encode(data)));
}

async function hashPassword(password, salt) {
  const k = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64u(salt), iterations: PBKDF2_ITER }, k, 256);
  return b64u(bits);
}

function sameString(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

async function makeToken(env, user) {
  const body = b64u(enc.encode(JSON.stringify({ e: user.email, v: user.ver, x: Date.now() + TOKEN_DAYS * 864e5 })));
  return `${body}.${await hmac(await secret(env), body)}`;
}

async function auth(env, req) {
  const h = req.headers.get('Authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : '';
  const [body, sig] = tok.split('.');
  if (!body || !sig) return null;
  if (!sameString(sig, await hmac(await secret(env), body))) return null;
  let p;
  try { p = JSON.parse(new TextDecoder().decode(fromB64u(body))); } catch { return null; }
  if (!p.e || p.x < Date.now()) return null;
  const u = await env.DB.prepare('SELECT email, name, role, tours, ver FROM users WHERE email = ?').bind(p.e).first();
  if (!u || u.ver !== p.v) return null;
  u.tours = JSON.parse(u.tours || '[]');
  return u;
}

const canSee = (u, tour) => u.role === 'admin' || u.tours.includes('*') || u.tours.includes(tour);
const publicUser = (u) => ({ email: u.email, name: u.name, role: u.role, tours: u.tours });
const cleanEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 200;

// ------------------------------------------------------------------ collect
async function collect(env, req) {
  const text = await req.text();
  if (text.length > MAX_BODY) return new Response('too big', { status: 413 });
  let d;
  try { d = JSON.parse(text); } catch { return new Response('bad json', { status: 400 }); }
  if (!d || !TOUR_RE.test(d.tour || '') || !SID_RE.test(d.sid || '')) return new Response('bad', { status: 400 });
  const now = Date.now();
  const started = Number.isFinite(d.started) ? Math.min(now, Math.max(now - 864e5, d.started)) : now;
  const dur = Math.max(0, Math.min(86400, Number(d.dur) || 0));
  const device = d.device === 'touch' ? 'touch' : 'desktop';
  const country = (req.cf && typeof req.cf.country === 'string') ? req.cf.country.slice(0, 2) : null;
  const { tour, sid } = d;
  delete d.tour; delete d.sid;
  await env.DB.prepare(`INSERT INTO sessions (sid, tour, started, updated, dur, device, country, data)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
      ON CONFLICT(sid) DO UPDATE SET updated = excluded.updated, dur = MAX(sessions.dur, excluded.dur), data = excluded.data
      WHERE sessions.tour = excluded.tour`)
    .bind(sid, tour, started, now, dur, device, country, JSON.stringify(d)).run();
  return new Response(null, { status: 204 });
}

// ------------------------------------------------------------------ router
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const ch = cors(env, req);
    if (req.method === 'OPTIONS') return new Response(null, { status: ch['Access-Control-Allow-Origin'] ? 204 : 403, headers: ch });
    try {
      await schema(env);

      if (path === '/collect' && req.method === 'POST') {
        // the viewer's beacon; accept only from our own sites
        if (!allowedOrigin(env, req.headers.get('Origin'))) return new Response('forbidden', { status: 403 });
        const r = await collect(env, req);
        return new Response(r.body, { status: r.status, headers: ch });
      }

      if (path === '/' ) return new Response('intus stats', { headers: { 'Content-Type': 'text/plain' } });

      if (!ch['Access-Control-Allow-Origin'] && req.headers.get('Origin')) return json({ error: 'origin not allowed' }, 403);

      if (path === '/auth/status') {
        const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
        return json({ setup: !n.n, setupEnabled: !!env.SETUP_CODE }, 200, ch);
      }

      if (path === '/auth/setup' && req.method === 'POST') {
        const b = await req.json();
        const n = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first();
        if (n.n) return json({ error: 'Already set up.' }, 400, ch);
        if (!env.SETUP_CODE) return json({ error: 'Set the SETUP_CODE secret in Cloudflare first.' }, 400, ch);
        if (!sameString(String(b.code || ''), env.SETUP_CODE)) return json({ error: 'Wrong setup code.' }, 403, ch);
        const email = cleanEmail(b.email);
        if (!validEmail(email)) return json({ error: 'Enter a valid email.' }, 400, ch);
        if (String(b.password || '').length < 10) return json({ error: 'Use at least 10 characters for the password.' }, 400, ch);
        const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
        const user = { email, name: String(b.name || '').slice(0, 100), role: 'admin', tours: '["*"]', ver: 1 };
        await env.DB.prepare('INSERT INTO users (email, name, role, tours, salt, hash, ver, created) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
          .bind(email, user.name, 'admin', '["*"]', salt, await hashPassword(b.password, salt), Date.now()).run();
        return json({ token: await makeToken(env, user), user: { ...user, tours: ['*'] } }, 200, ch);
      }

      if (path === '/auth/login' && req.method === 'POST') {
        const b = await req.json();
        const email = cleanEmail(b.email);
        const fail = await env.DB.prepare('SELECT count, until FROM login_fail WHERE email = ?').bind(email).first();
        if (fail && fail.until > Date.now()) return json({ error: 'Too many attempts - try again in a few minutes.' }, 429, ch);
        const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(email).first();
        const ok = u && sameString(await hashPassword(String(b.password || ''), u.salt), u.hash);
        if (!ok) {
          const c = (fail ? fail.count : 0) + 1;
          await env.DB.prepare('INSERT OR REPLACE INTO login_fail (email, count, until) VALUES (?, ?, ?)')
            .bind(email, c >= 5 ? 0 : c, c >= 5 ? Date.now() + 10 * 60e3 : 0).run();
          return json({ error: 'Wrong email or password.' }, 401, ch);
        }
        await env.DB.prepare('DELETE FROM login_fail WHERE email = ?').bind(email).run();
        u.tours = JSON.parse(u.tours);
        return json({ token: await makeToken(env, u), user: publicUser(u) }, 200, ch);
      }

      if (!path.startsWith('/api/')) return json({ error: 'not found' }, 404, ch);
      const me = await auth(env, req);
      if (!me) return json({ error: 'Please sign in again.' }, 401, ch);

      if (path === '/api/me') return json({ user: publicUser(me) }, 200, ch);

      if (path === '/api/me/password' && req.method === 'POST') {
        const b = await req.json();
        if (String(b.password || '').length < 10) return json({ error: 'Use at least 10 characters.' }, 400, ch);
        const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
        await env.DB.prepare('UPDATE users SET salt = ?, hash = ?, ver = ver + 1 WHERE email = ?')
          .bind(salt, await hashPassword(b.password, salt), me.email).run();
        const u = await env.DB.prepare('SELECT * FROM users WHERE email = ?').bind(me.email).first();
        u.tours = JSON.parse(u.tours);
        return json({ token: await makeToken(env, u) }, 200, ch);
      }

      if (path === '/api/tours') {
        const { results } = await env.DB.prepare(
          'SELECT tour, COUNT(*) AS visits, MAX(started) AS last, SUM(dur) AS seconds FROM sessions GROUP BY tour ORDER BY last DESC').all();
        const tours = results.filter((r) => canSee(me, r.tour));
        if (me.role !== 'admin') for (const t of me.tours) if (t !== '*' && !tours.some((r) => r.tour === t)) tours.push({ tour: t, visits: 0 });
        return json({ tours }, 200, ch);
      }

      if (path === '/api/sessions' && req.method === 'GET') {
        const tour = url.searchParams.get('tour') || '';
        if (!TOUR_RE.test(tour) || !canSee(me, tour)) return json({ error: 'No access to this tour.' }, 403, ch);
        const from = Number(url.searchParams.get('from')) || 0;
        const to = Number(url.searchParams.get('to')) || 8.64e15;
        const limit = Math.min(1000, Number(url.searchParams.get('limit')) || 500);
        const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
        const { results } = await env.DB.prepare(
          'SELECT sid, started, dur, device, country, data FROM sessions WHERE tour = ? AND started >= ? AND started < ? ORDER BY started DESC LIMIT ? OFFSET ?')
          .bind(tour, from, to, limit, offset).all();
        // data is stored as validated JSON text: splice it in instead of parsing and re-encoding it
        const body = '{"sessions":[' + results.map((r) =>
          `{"sid":${JSON.stringify(r.sid)},"started":${r.started},"dur":${r.dur},"device":${JSON.stringify(r.device)},"country":${JSON.stringify(r.country)},"data":${r.data}}`).join(',') + `],"more":${results.length === limit}}`;
        return json(body, 200, ch);
      }

      if (me.role !== 'admin') return json({ error: 'Only for admins.' }, 403, ch);

      if (path === '/api/sessions' && req.method === 'DELETE') {
        const tour = url.searchParams.get('tour') || '';
        const sid = url.searchParams.get('sid');
        if (!TOUR_RE.test(tour)) return json({ error: 'bad tour' }, 400, ch);
        const r = sid
          ? await env.DB.prepare('DELETE FROM sessions WHERE tour = ? AND sid = ?').bind(tour, sid).run()
          : await env.DB.prepare('DELETE FROM sessions WHERE tour = ?').bind(tour).run();
        return json({ removed: r.meta.changes }, 200, ch);
      }

      if (path === '/api/users' && req.method === 'GET') {
        const { results } = await env.DB.prepare('SELECT email, name, role, tours, created FROM users ORDER BY created').all();
        return json({ users: results.map((u) => ({ ...u, tours: JSON.parse(u.tours) })) }, 200, ch);
      }

      if (path === '/api/users' && req.method === 'POST') {
        // add or update an account; a new account (or reset) gets a generated password, shown once
        const b = await req.json();
        const email = cleanEmail(b.email);
        if (!validEmail(email)) return json({ error: 'Enter a valid email.' }, 400, ch);
        const role = b.role === 'admin' ? 'admin' : 'broker';
        const tours = role === 'admin' ? ['*'] : (Array.isArray(b.tours) ? b.tours.filter((t) => t === '*' || TOUR_RE.test(t)) : []);
        const existing = await env.DB.prepare('SELECT email FROM users WHERE email = ?').bind(email).first();
        if (existing) {
          await env.DB.prepare('UPDATE users SET name = ?, role = ?, tours = ? WHERE email = ?')
            .bind(String(b.name || '').slice(0, 100), role, JSON.stringify(tours), email).run();
          return json({ ok: true }, 200, ch);
        }
        const password = randomString(14);
        const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
        await env.DB.prepare('INSERT INTO users (email, name, role, tours, salt, hash, ver, created) VALUES (?, ?, ?, ?, ?, ?, 1, ?)')
          .bind(email, String(b.name || '').slice(0, 100), role, JSON.stringify(tours), salt, await hashPassword(password, salt), Date.now()).run();
        return json({ ok: true, password }, 200, ch);
      }

      if (path === '/api/users/reset' && req.method === 'POST') {
        const b = await req.json();
        const email = cleanEmail(b.email);
        const password = randomString(14);
        const salt = b64u(crypto.getRandomValues(new Uint8Array(16)));
        const r = await env.DB.prepare('UPDATE users SET salt = ?, hash = ?, ver = ver + 1 WHERE email = ?')
          .bind(salt, await hashPassword(password, salt), email).run();
        if (!r.meta.changes) return json({ error: 'No such account.' }, 404, ch);
        return json({ ok: true, password }, 200, ch);
      }

      if (path === '/api/users' && req.method === 'DELETE') {
        const email = cleanEmail(url.searchParams.get('email'));
        if (email === me.email) return json({ error: "You can't remove your own account." }, 400, ch);
        await env.DB.prepare('DELETE FROM users WHERE email = ?').bind(email).run();
        return json({ ok: true }, 200, ch);
      }

      return json({ error: 'not found' }, 404, ch);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500, ch);
    }
  },
};
