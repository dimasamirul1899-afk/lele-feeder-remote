// LeleFeeder Remote — server dashboard + MQTT bridge
// ESP32 (otak alat pakan lele) <-> Mosquitto <-> server ini <-> web dashboard
// Node stdlib + mqtt. Data: JSON file (devices.json, events.jsonl, power.jsonl).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mqtt = require('mqtt');

const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');
fs.mkdirSync(DATA, { recursive: true });

// ---------- .env ----------
const env = {};
try {
  for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const i = l.indexOf('=');
    if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
  }
} catch (e) { /* .env opsional saat dev lokal */ }
const PORT = parseInt(process.env.PORT || env.PORT || '3102', 10);
const MQTT_HOST = process.env.MQTT_HOST || env.MQTT_HOST || '127.0.0.1';
const MQTT_PORT = parseInt(process.env.MQTT_PORT || env.MQTT_PORT || '1883', 10);
const MQTT_USER = process.env.MQTT_USER || env.MQTT_USER || '';
const MQTT_PASS = process.env.MQTT_PASS || env.MQTT_PASS || '';

// ---------- WIB helpers (UTC+7) ----------
const WIB = 7 * 3600 * 1000;
function wib(d) { const x = new Date((d instanceof Date ? d.getTime() : d) + WIB); return { y: x.getUTCFullYear(), m: x.getUTCMonth(), d: x.getUTCDate(), dow: x.getUTCDay(), hh: x.getUTCHours(), mm: x.getUTCMinutes(), ss: x.getUTCSeconds() }; }
function dayKey(ts) { const p = wib(ts); return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; }
function dayStartTs(key) { const [y, m, d] = key.split('-').map(Number); return Date.UTC(y, m - 1, d) - WIB; }
function todayKey(now = Date.now()) { return dayKey(now); }
function weekStartKey(now = Date.now()) { // Senin
  const p = wib(now);
  const shift = (p.dow + 6) % 7; // Senin=0
  return dayKey(now - shift * 86400000);
}
function monthKey(now = Date.now()) { const p = wib(now); return `${p.y}-${String(p.m + 1).padStart(2, '0')}`; }
function fmtClock(ts) { const p = wib(ts); return `${String(p.hh).padStart(2, '0')}:${String(p.mm).padStart(2, '0')}`; }
function fmtDateTime(ts) { const p = wib(ts); return `${String(p.d).padStart(2, '0')}/${String(p.m + 1).padStart(2, '0')}/${p.y} ${fmtClock(ts)}`; }
const DAY_NAMES = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

// ---------- store ----------
const DEVICES_FILE = path.join(DATA, 'devices.json');
const EVENTS_FILE = path.join(DATA, 'events.jsonl');
const POWER_FILE = path.join(DATA, 'power.jsonl');
function loadDevices() {
  try { return JSON.parse(fs.readFileSync(DEVICES_FILE, 'utf8')); } catch (e) { return {}; }
}
function saveDevices(d) { fs.writeFileSync(DEVICES_FILE, JSON.stringify(d, null, 2)); }
function appendLine(file, obj) { fs.appendFileSync(file, JSON.stringify(obj) + '\n'); }
function readLines(file, max = 5000) {
  try {
    const txt = fs.readFileSync(file, 'utf8').trim();
    if (!txt) return [];
    const lines = txt.split('\n');
    return lines.slice(-max).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}
const DEFAULT_CONFIG = {
  id: 'lele-01', name: 'Kolam Lele 01',
  activeDays: [1, 2, 3, 4, 5, 6, 0],
  schedules: [
    { time: '07:00', grams: 60, enabled: true },
    { time: '12:00', grams: 60, enabled: true },
    { time: '17:00', grams: 80, enabled: true },
  ],
  gramsPerSecond: 10,
};
let devices = loadDevices(); // id -> config
// runtime state: id -> { online, telemetry, lastSeen, lastStatusChange }
const runtime = {};
function ensureDevice(id) {
  if (!devices[id]) {
    devices[id] = { ...JSON.parse(JSON.stringify(DEFAULT_CONFIG)), id };
    saveDevices(devices);
  }
  if (!runtime[id]) runtime[id] = { online: false, telemetry: null, lastSeen: 0, lastStatusChange: 0 };
  return devices[id];
}
function validateConfig(c) {
  if (!c || typeof c !== 'object') return 'config harus object';
  if (typeof c.name === 'string') c.name = c.name.slice(0, 40);
  if (!Array.isArray(c.activeDays) || c.activeDays.some(d => d < 0 || d > 6)) return 'activeDays harus array 0-6';
  c.activeDays = [...new Set(c.activeDays.map(Number))];
  if (!Array.isArray(c.schedules) || c.schedules.length === 0 || c.schedules.length > 6) return 'schedules 1-6 slot';
  for (const s of c.schedules) {
    if (!/^\d{2}:\d{2}$/.test(s.time || '')) return 'jam harus HH:MM';
    const [h, m] = s.time.split(':').map(Number);
    if (h > 23 || m > 59) return 'jam tidak valid';
    s.grams = Math.max(1, Math.min(500, parseInt(s.grams, 10) || 50));
    s.enabled = !!s.enabled;
  }
  c.gramsPerSecond = Math.max(1, Math.min(100, parseInt(c.gramsPerSecond, 10) || 10));
  return null;
}
function nextFeed(cfg, now = Date.now()) {
  // cari slot berikut dalam 48 jam ke depan
  for (let add = 0; add < 2; add++) {
    const base = now + add * 86400000;
    const p = wib(base);
    if (!cfg.activeDays.includes(p.dow)) continue;
    for (const s of cfg.schedules.filter(x => x.enabled).sort((a, b) => a.time.localeCompare(b.time))) {
      const [h, m] = s.time.split(':').map(Number);
      const ts = Date.UTC(p.y, p.m, p.d, h, m) - WIB;
      if (ts > now) return { time: s.time, grams: s.grams, at: ts, inMin: Math.round((ts - now) / 60000) };
    }
  }
  return null;
}

// ---------- reports (dari events.jsonl — sumber kebenaran) ----------
function reportFor(id, range, now = Date.now()) {
  const evs = readLines(EVENTS_FILE).filter(e => e.device === id && e.type === 'feed');
  let from, label;
  if (range === 'week') { from = dayStartTs(weekStartKey(now)); label = 'Minggu ini'; }
  else if (range === 'month') { const mk = monthKey(now); const [y, m] = mk.split('-').map(Number); from = Date.UTC(y, m - 1, 1) - WIB; label = 'Bulan ini'; }
  else { from = dayStartTs(todayKey(now)); label = 'Hari ini'; }
  const sel = evs.filter(e => e.ts >= from);
  const totalG = sel.reduce((a, e) => a + (e.grams || 0), 0);
  return { range, label, from, totalG, sessions: sel.length, events: sel.slice(-50).reverse() };
}
function last7Days(id, now = Date.now()) {
  const evs = readLines(EVENTS_FILE).filter(e => e.device === id && e.type === 'feed');
  const out = [];
  for (let i = 6; i >= 0; i--) {
    const key = dayKey(now - i * 86400000);
    const from = dayStartTs(key), to = from + 86400000;
    const sel = evs.filter(e => e.ts >= from && e.ts < to);
    const p = wib(from);
    out.push({ key, label: DAY_NAMES[p.dow], grams: sel.reduce((a, e) => a + (e.grams || 0), 0), sessions: sel.length });
  }
  return out;
}

// ---------- auth gate (pola sama: malika-chat / video-studio) ----------
const AUTH_FILE = path.join(DATA, 'auth.json');
const TOKENS_FILE = path.join(DATA, 'tokens.json');
function loadJson(file, fb) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return fb; } }
function saveJson(file, obj) { fs.writeFileSync(file, JSON.stringify(obj)); }
function hashPw(pw, salt) { return crypto.scryptSync(pw, salt, 64).toString('hex'); }
function needsSetup() { return !fs.existsSync(AUTH_FILE); }
function checkPw(pw) {
  const a = loadJson(AUTH_FILE, null);
  if (!a) return false;
  try { return crypto.timingSafeEqual(Buffer.from(hashPw(pw, a.salt), 'hex'), Buffer.from(a.hash, 'hex')); } catch (e) { return false; }
}
function issueToken() {
  const t = crypto.randomBytes(24).toString('hex');
  const toks = loadJson(TOKENS_FILE, {});
  toks[t] = Date.now();
  saveJson(TOKENS_FILE, toks);
  return t;
}
function validToken(req) {
  const m = (req.headers.cookie || '').match(/lele_token=([a-f0-9]+)/);
  if (!m) return false;
  const toks = loadJson(TOKENS_FILE, {});
  if (!toks[m[1]]) return false;
  if (Date.now() - toks[m[1]] > 30 * 86400000) { delete toks[m[1]]; saveJson(TOKENS_FILE, toks); return false; }
  return true;
}

// ---------- MQTT ----------
const sseClients = new Set();
function broadcast(msg) {
  const data = `data: ${JSON.stringify(msg)}\n\n`;
  for (const res of [...sseClients]) { try { res.write(data); } catch (e) { sseClients.delete(res); } }
}
const mqttClient = mqtt.connect(`mqtt://${MQTT_HOST}:${MQTT_PORT}`, {
  username: MQTT_USER || undefined,
  password: MQTT_PASS || undefined,
  clientId: 'lele-server-' + crypto.randomBytes(3).toString('hex'),
  keepalive: 60, reconnectPeriod: 5000, connectTimeout: 10000,
});
mqttClient.on('connect', () => {
  console.log('[mqtt] connected to', MQTT_HOST + ':' + MQTT_PORT);
  mqttClient.subscribe(['asta/lele/+/telemetry', 'asta/lele/+/event', 'asta/lele/+/status'], { qos: 1 }, (err) => {
    if (err) console.log('[mqtt] subscribe err', err.message);
  });
  // publish retained config untuk semua device yang dikenal
  for (const id of Object.keys(devices)) {
    mqttClient.publish(`asta/lele/${id}/config`, JSON.stringify(devices[id]), { retain: true, qos: 1 });
  }
});
mqttClient.on('error', (e) => console.log('[mqtt] error', e.message));
mqttClient.on('message', (topic, payload) => {
  const parts = topic.split('/');
  if (parts.length < 4 || parts[0] !== 'asta' || parts[1] !== 'lele') return;
  const id = parts[2], kind = parts[3];
  const cfg = ensureDevice(id);
  const rt = runtime[id];
  const now = Date.now();
  if (kind === 'telemetry') {
    try { rt.telemetry = JSON.parse(payload.toString()); } catch (e) { return; }
    rt.lastSeen = now;
    if (!rt.online) { rt.online = true; rt.lastStatusChange = now; appendLine(POWER_FILE, { ts: now, device: id, state: 'online', via: 'telemetry' }); }
    broadcast({ type: 'telemetry', device: id, data: rt.telemetry });
  } else if (kind === 'event') {
    let ev; try { ev = JSON.parse(payload.toString()); } catch (e) { return; }
    ev.device = id; ev.ts = ev.ts ? ev.ts * 1000 : now;
    if (ev.type === 'feed' || ev.type === 'power' || ev.type === 'config') appendLine(EVENTS_FILE, ev);
    broadcast({ type: 'event', device: id, data: ev });
  } else if (kind === 'status') {
    const s = payload.toString().trim();
    const online = s === 'online';
    if (rt.online !== online) {
      rt.online = online; rt.lastStatusChange = now;
      appendLine(POWER_FILE, { ts: now, device: id, state: online ? 'online' : 'offline', via: 'lwt' });
      broadcast({ type: 'status', device: id, online });
    }
    if (online) rt.lastSeen = now;
  }
});

// ---------- HTTP ----------
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}
function deviceView(id) {
  const cfg = devices[id];
  const rt = runtime[id] || { online: false, telemetry: null, lastSeen: 0 };
  const rep = reportFor(id, 'today');
  return {
    id, name: cfg.name, config: cfg,
    online: rt.online, telemetry: rt.telemetry, lastSeen: rt.lastSeen,
    nextFeed: nextFeed(cfg),
    today: { totalG: rep.totalG, sessions: rep.sessions },
  };
}
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  // --- public: setup/auth API ---
  if (p === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, { needsSetup: needsSetup(), authed: validToken(req), devices: Object.keys(devices).map(deviceView), now: Date.now() });
  }
  if (p === '/api/setup' && req.method === 'POST') {
    if (!needsSetup()) return sendJson(res, 400, { error: 'sudah disetup' });
    const b = await readBody(req);
    if (!b.password || b.password.length < 6) return sendJson(res, 400, { error: 'password min 6 karakter' });
    const salt = crypto.randomBytes(16).toString('hex');
    saveJson(AUTH_FILE, { salt, hash: hashPw(b.password, salt) });
    const t = issueToken();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `lele_token=${t}; Path=/; HttpOnly; Max-Age=${30 * 86400}` });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (p === '/api/auth' && req.method === 'POST') {
    const b = await readBody(req);
    if (!checkPw(b.password || '')) return sendJson(res, 401, { error: 'password salah' });
    const t = issueToken();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': `lele_token=${t}; Path=/; HttpOnly; Max-Age=${30 * 86400}` });
    return res.end(JSON.stringify({ ok: true }));
  }
  if (p === '/api/logout' && req.method === 'POST') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'lele_token=; Path=/; HttpOnly; Max-Age=0' });
    return res.end(JSON.stringify({ ok: true }));
  }

  // --- gate: hanya API yang butuh login; halaman + aset statis selalu disajikan ---
  // (form login/setup ada di index.html; app.js cek /api/status untuk menampilkannya)
  // BUG 2026-11-18 18:15: gate lama memblokir GET / juga, jadi browser tanpa cookie
  // hanya dapat JSON 401 "login dulu" dan tidak pernah melihat form login.
  const isApi = p.startsWith('/api/');
  if (isApi && !needsSetup() && !validToken(req)) return sendJson(res, 401, { error: 'login dulu' });

  // --- SSE ---
  if (p === '/api/stream' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    sseClients.add(res);
    const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (e) { clearInterval(hb); } }, 25000);
    req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
    return;
  }

  // --- devices API ---
  if (p === '/api/devices' && req.method === 'GET') {
    return sendJson(res, 200, { devices: Object.keys(devices).map(deviceView) });
  }
  const mDev = p.match(/^\/api\/device\/([\w-]+)\/(report|events|feed|config|power)$/);
  if (mDev) {
    const id = mDev[1], act = mDev[2];
    if (!devices[id]) return sendJson(res, 404, { error: 'device tidak dikenal' });
    if (act === 'report' && req.method === 'GET') {
      const range = ['today', 'week', 'month'].includes(url.searchParams.get('range')) ? url.searchParams.get('range') : 'today';
      const rep = reportFor(id, range);
      return sendJson(res, 200, { ...rep, week: reportFor(id, 'week'), month: reportFor(id, 'month'), last7: last7Days(id) });
    }
    if (act === 'events' && req.method === 'GET') {
      const feeds = readLines(EVENTS_FILE).filter(e => e.device === id).slice(-50).reverse();
      return sendJson(res, 200, { events: feeds });
    }
    if (act === 'power' && req.method === 'GET') {
      const pw = readLines(POWER_FILE).filter(e => e.device === id).slice(-50).reverse();
      return sendJson(res, 200, { power: pw });
    }
    if (act === 'feed' && req.method === 'POST') {
      const b = await readBody(req);
      const grams = Math.max(1, Math.min(500, parseInt(b.grams, 10) || 50));
      const rt = runtime[id];
      if (!rt || !rt.online) return sendJson(res, 409, { error: 'device offline — tidak bisa beri pakan jarak jauh' });
      const requestId = crypto.randomBytes(6).toString('hex');
      mqttClient.publish(`asta/lele/${id}/cmd`, JSON.stringify({ action: 'feed_now', grams, requestId }), { qos: 1 });
      return sendJson(res, 200, { ok: true, grams, requestId });
    }
    if (act === 'config' && req.method === 'POST') {
      const b = await readBody(req);
      const cfg = { ...devices[id], ...(b.config || {}) };
      cfg.id = id;
      const err = validateConfig(cfg);
      if (err) return sendJson(res, 400, { error: err });
      devices[id] = cfg;
      saveDevices(devices);
      mqttClient.publish(`asta/lele/${id}/config`, JSON.stringify(cfg), { retain: true, qos: 1 });
      mqttClient.publish(`asta/lele/${id}/cmd`, JSON.stringify({ action: 'set_config', config: cfg }), { qos: 1 });
      return sendJson(res, 200, { ok: true, config: cfg, nextFeed: nextFeed(cfg) });
    }
  }

  // --- static ---
  if (req.method === 'GET') {
    let fp = p === '/' ? '/index.html' : p;
    fp = path.join(ROOT, 'public', fp);
    if (!fp.startsWith(path.join(ROOT, 'public'))) return sendJson(res, 403, { error: 'forbidden' });
    try {
      const data = fs.readFileSync(fp);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
      return res.end(data);
    } catch (e) { return sendJson(res, 404, { error: 'tidak ditemukan' }); }
  }
  return sendJson(res, 404, { error: 'tidak ditemukan' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[lele-feeder] listening 127.0.0.1:${PORT} — mqtt ${MQTT_HOST}:${MQTT_PORT}`);
  ensureDevice('lele-01');
});
