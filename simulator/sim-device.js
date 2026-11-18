// Simulator device lele-01 — untuk testing server TANPA hardware.
// Jalankan DI VPS (punya .env): node simulator/sim-device.js
// Perilaku: connect sebagai lele-esp32-01, publish telemetry 10 dtk,
// balas cmd feed_now (simulasi putaran servo), terima config, LWT offline.
'use strict';
const mqtt = require('mqtt');
const fs = require('fs');
const path = require('path');

const env = {};
for (const line of fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8').split('\n')) {
  const l = line.trim();
  if (!l || l.startsWith('#')) continue;
  const i = l.indexOf('=');
  if (i > 0) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
const ID = process.env.DEVICE_ID || 'lele-01';
const BASE = `asta/lele/${ID}/`;
let cfg = {
  id: ID, name: 'Kolam Lele 01 (SIM)',
  activeDays: [1, 2, 3, 4, 5, 6, 0],
  schedules: [
    { time: '07:00', grams: 60, enabled: true },
    { time: '12:00', grams: 60, enabled: true },
    { time: '17:00', grams: 80, enabled: true },
  ],
  gramsPerSecond: 10,
};
let feedTodayG = 0, sessionsToday = 0, lastFeedAt = 0, feeding = false;
const bootSec = Math.floor(Date.now() / 1000);

const c = mqtt.connect('mqtt://127.0.0.1:1883', {
  username: env.ESP_MQTT_USER, password: env.ESP_MQTT_PASS,
  clientId: ID, keepalive: 60,
  will: { topic: BASE + 'status', payload: 'offline', retain: true, qos: 1 },
});
function telemetry() {
  c.publish(BASE + 'telemetry', JSON.stringify({
    ts: Math.floor(Date.now() / 1000),
    state: feeding ? 'feeding' : 'idle',
    feedTodayG, sessionsToday,
    lastFeedAt, nextFeedAt: 0,
    uptimeSec: Math.floor(Date.now() / 1000) - bootSec,
    rssi: -58, freeHeap: 150000,
  }), { qos: 1 });
}
c.on('connect', () => {
  console.log('[sim] connected as', ID);
  c.subscribe([BASE + 'cmd', BASE + 'config'], { qos: 1 });
  c.publish(BASE + 'status', 'online', { retain: true, qos: 1 });
  c.publish(BASE + 'event', JSON.stringify({ ts: Math.floor(Date.now() / 1000), type: 'power', note: 'boot' }), { qos: 1 });
  telemetry();
  setInterval(telemetry, 10000);
});
c.on('message', (topic, payload) => {
  const msg = payload.toString();
  console.log('[sim] recv', topic, msg.slice(0, 200));
  if (topic === BASE + 'config') {
    try { const nc = JSON.parse(msg); if (nc.id) { cfg = nc; console.log('[sim] config applied, slots:', cfg.schedules.length); } } catch (e) { /* abaikan */ }
    c.publish(BASE + 'event', JSON.stringify({ ts: Math.floor(Date.now() / 1000), type: 'config', note: 'config applied' }), { qos: 1 });
    return;
  }
  if (topic === BASE + 'cmd') {
    let m; try { m = JSON.parse(msg); } catch (e) { return; }
    if (m.action === 'feed_now') {
      const grams = Math.max(1, Math.min(500, m.grams || 50));
      const dur = Math.max(1, Math.round(grams / (cfg.gramsPerSecond || 10)));
      console.log(`[sim] feeding ${grams}g (~${dur}s)`);
      feeding = true; telemetry();
      setTimeout(() => {
        feeding = false;
        feedTodayG += grams; sessionsToday++;
        lastFeedAt = Math.floor(Date.now() / 1000);
        c.publish(BASE + 'event', JSON.stringify({ ts: lastFeedAt, type: 'feed', grams, trigger: 'remote' }), { qos: 1 });
        telemetry();
        console.log('[sim] feed event sent', grams + 'g');
      }, Math.min(dur, 5) * 1000);
    } else if (m.action === 'ping') telemetry();
    else if (m.action === 'set_config' && m.config) { cfg = m.config; console.log('[sim] set_config applied'); }
  }
});
c.on('error', (e) => console.log('[sim] error', e.message));
console.log('[sim] starting, device', ID);
