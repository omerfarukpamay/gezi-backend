// ai-proxy.js
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Load local .env for dev (without overriding real environment variables).
// Render/production should use environment variables set in the service settings.
(() => {
  try {
    const envPath = path.join(__dirname, '.env');
    if (!fs.existsSync(envPath)) return;
    const raw = fs.readFileSync(envPath, 'utf-8');
    raw.split(/\r?\n/).forEach((line) => {
      const trimmed = String(line || '').trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const eq = trimmed.indexOf('=');
      if (eq <= 0) return;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (!key) return;
      if (process.env[key] !== undefined) return;
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    });
  } catch (e) {
    console.warn('[env] Failed to load local .env file.');
  }
})();

// Use global fetch (Node 18+) or fallback
const fetchFn = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const app = express();
app.use(express.json());

// CORS on every request + OPTIONS early return
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.get('/health', (req, res) => {
  res.status(200).json({ ok: true, ts: new Date().toISOString() });
});

const API_URL = 'https://api.openai.com/v1/chat/completions';
const PORT = process.env.PORT || 3001;
const API_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_KEY;
const CTA_TRAIN_TRACKER_KEY = process.env.CTA_TRAIN_TRACKER_KEY;

const { findNearby: findNearbyGtfsTransit } = require('./gtfs-cta.js');

// ----- lightweight user store + auth -----
const USERS_FILE = path.join(__dirname, 'users.json');
const SESSIONS = new Map(); // token -> { userId, expiresAt }
const SESSION_TTL_MS = 1000 * 60 * 60 * 2; // 2 hours

function readUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return [];
    const raw = fs.readFileSync(USERS_FILE, 'utf-8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[auth] failed to read users file', e);
    return [];
  }
}

function writeUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf-8');
  } catch (e) {
    console.error('[auth] failed to write users file', e);
  }
}

function hashPassword(password, salt) {
  const saltToUse = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, saltToUse, 100_000, 64, 'sha512').toString('hex');
  return { salt: saltToUse, hash };
}

function verifyPassword(password, user) {
  if (!user?.salt || !user?.hash) return false;
  const { hash } = hashPassword(password, user.salt);
  return hash === user.hash;
}

function makeToken(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  const expiresAt = Date.now() + SESSION_TTL_MS;
  SESSIONS.set(token, { userId, expiresAt });
  return token;
}

function cleanUser(u) {
  if (!u) return null;
  const { salt, hash, ...rest } = u;
  return rest;
}

function getUserByToken(token, users) {
  if (!token) return null;
  const session = SESSIONS.get(token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    SESSIONS.delete(token);
    return null;
  }
  const user = users.find(u => u.id === session.userId);
  if (!user) return null;
  // refresh ttl lazily
  session.expiresAt = Date.now() + SESSION_TTL_MS;
  return user;
}

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  req.users = req.users || readUsers();
  const user = getUserByToken(token, req.users);
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.authUser = user;
  next();
}

if (!API_KEY) console.warn('[ai-proxy] Missing OPENAI_API_KEY (or OPENAI_KEY) in environment.');

// ----- Auth routes -----
app.post('/api/register', (req, res) => {
  const { email, password, firstName = '', lastName = '' } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  if (password.length < 6) return res.status(400).json({ error: 'password too short' });

  const users = readUsers();
  const existing = users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (existing) return res.status(409).json({ error: 'email already exists' });

  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
    email,
    firstName,
    lastName,
    salt,
    hash,
    createdAt: new Date().toISOString()
  };
  users.push(user);
  writeUsers(users);

  const token = makeToken(user.id);
  return res.json({ token, user: cleanUser(user) });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password are required' });
  const users = readUsers();
  const user = users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user) return res.status(401).json({ error: 'invalid credentials' });
  if (!verifyPassword(password, user)) return res.status(401).json({ error: 'invalid credentials' });
  const token = makeToken(user.id);
  return res.json({ token, user: cleanUser(user) });
});

app.get('/api/me', authMiddleware, (req, res) => {
  return res.json({ user: cleanUser(req.authUser) });
});

app.post('/api/ai', async (req, res) => {
  try {
    // Ensure CORS headers on the actual response too
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    const { messages = [], model = 'gpt-4o', temperature = 0.7, max_tokens = 600 } = req.body || {};
    if (!API_KEY) return res.status(500).send('Server missing OPENAI_API_KEY');

    const upstream = await fetchFn(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${API_KEY}`
      },
      body: JSON.stringify({ model, messages, temperature, max_tokens })
    });

    if (!upstream.ok) {
      const errText = await upstream.text();
      return res.status(upstream.status).send(errText);
    }

    const json = await upstream.json();
    const reply = json.choices?.[0]?.message?.content || '';
    return res.json({ reply, usage: json.usage, raw: json });
  } catch (err) {
    console.error('[ai-proxy] error', err);
    res.status(500).send('AI proxy error');
  }
});

// ----- CTA Train Tracker proxy (keeps API key server-side) -----
app.get('/api/cta/train-arrivals', async (req, res) => {
  try {
    const mapid = String(req.query.mapid || '').trim();
    const max = Math.max(1, Math.min(10, Number(req.query.max) || 6));
    if (!mapid) return res.status(400).json({ error: 'mapid is required' });
    if (!CTA_TRAIN_TRACKER_KEY) return res.status(501).json({ error: 'server missing CTA_TRAIN_TRACKER_KEY' });

    const url = new URL('https://lapi.transitchicago.com/api/1.0/ttarrivals.aspx');
    url.searchParams.set('key', CTA_TRAIN_TRACKER_KEY);
    url.searchParams.set('mapid', mapid);
    url.searchParams.set('max', String(max));
    url.searchParams.set('outputType', 'JSON');

    const upstream = await fetchFn(url.toString());
    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => '');
      return res.status(upstream.status).json({ error: errText || 'CTA request failed' });
    }
    const json = await upstream.json().catch(() => ({}));
    const eta = json?.ctatt?.eta;
    const list = Array.isArray(eta) ? eta : (eta ? [eta] : []);

    const now = Date.now();
    const arrivals = list
      .map((item) => {
        const route = String(item?.rt || '').trim();
        const destination = String(item?.destNm || '').trim();
        const arrT = String(item?.arrT || '').trim();
        const isApp = String(item?.isApp || '').trim() === '1';
        const isDly = String(item?.isDly || '').trim() === '1';
        const isSch = String(item?.isSch || '').trim() === '1';
        let minutes = null;
        if (arrT) {
          const ts = Date.parse(arrT);
          if (!Number.isNaN(ts)) minutes = Math.max(0, Math.round((ts - now) / 60000));
        }
        return {
          route: route || 'Train',
          destination: destination || 'Unknown',
          minutes,
          isApproaching: isApp,
          isDelayed: isDly,
          isScheduled: isSch
        };
      })
      .filter(a => a && typeof a.minutes === 'number')
      .sort((a, b) => a.minutes - b.minutes);

    return res.json({ arrivals });
  } catch (err) {
    console.error('[cta] error', err);
    return res.status(500).json({ error: 'CTA proxy error' });
  }
});

// ----- GTFS (CTA) nearby transit (bus + train, no key) -----
app.get('/api/transit/nearby', async (req, res) => {
  try {
    const lat = Number(req.query.lat);
    const lng = Number(req.query.lng);
    const radius = Math.max(200, Math.min(5000, Number(req.query.radius) || 1200));
    const limit = Math.max(3, Math.min(25, Number(req.query.limit) || 12));
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return res.status(400).json({ error: 'lat and lng are required' });
    }
    const data = await findNearbyGtfsTransit({ fetchFn, lat, lng, radiusMeters: radius, limit });
    return res.json({ ...data, source: 'cta_gtfs' });
  } catch (err) {
    console.error('[gtfs] error', err);
    return res.status(500).json({ error: 'GTFS transit lookup failed' });
  }
});

app.listen(PORT, () => {
  console.log(`[ai-proxy] listening on http://localhost:${PORT}`);
});
