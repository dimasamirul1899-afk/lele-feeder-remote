// LeleFeeder Remote — dashboard logic
'use strict';
const $ = (s) => document.querySelector(s);
const DAY_LABELS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
let devices = [];
let cur = null; // device view
let cfgDraft = null;
let logTab = 'feed';

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  setTimeout(() => t.classList.add('hidden'), ms);
}
function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
}
function fmtDT(ts) {
  return new Date(ts).toLocaleString('id-ID', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Jakarta' });
}
async function api(path, opts = {}) {
  const r = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status));
  return j;
}

// ---------- auth ----------
async function boot() {
  const st = await api('/api/status');
  if (st.needsSetup) {
    showAuth('Buat Password', 'Kunjungan pertama — buat password untuk dashboard ini. Password hanya tersimpan sebagai hash di server.');
    $('#authBtn').textContent = 'Buat Password & Masuk';
  } else if (!st.authed) {
    showAuth('LeleFeeder Remote', 'Masuk untuk mengontrol alat pakan lele.');
    $('#authBtn').textContent = 'Masuk';
  } else {
    enterApp(st);
  }
  $('#authBtn').onclick = async () => {
    const pw = $('#authPw').value;
    if (pw.length < 6) return authErr('Password min 6 karakter.');
    try {
      const st = await api('/api/status');
      if (st.needsSetup) await api('/api/setup', { method: 'POST', body: JSON.stringify({ password: pw }) });
      else await api('/api/auth', { method: 'POST', body: JSON.stringify({ password: pw }) });
      location.reload();
    } catch (e) { authErr(e.message); }
  };
  $('#authPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#authBtn').click(); });
}
function showAuth(title, desc) {
  $('#authTitle').textContent = title;
  $('#authDesc').textContent = desc;
  $('#authView').classList.remove('hidden');
  $('#appView').classList.add('hidden');
  setTimeout(() => $('#authPw').focus(), 50);
}
function authErr(m) { const e = $('#authErr'); e.textContent = m; e.classList.remove('hidden'); }

// ---------- app ----------
function enterApp(st) {
  $('#authView').classList.add('hidden');
  $('#appView').classList.remove('hidden');
  devices = st.devices;
  const sel = $('#devSel');
  sel.innerHTML = devices.map(d => `<option value="${d.id}">${d.name} (${d.id})</option>`).join('');
  sel.onchange = () => { loadDevice(sel.value); };
  if (devices.length) loadDevice(devices[0].id);
  startClock();
  startSSE();
  $('#logoutBtn').onclick = async () => { await api('/api/logout', { method: 'POST' }); location.reload(); };
  $('#feedBtn').onclick = feedNow;
  $('#addSlotBtn').onclick = () => {
    if (cfgDraft.schedules.length >= 6) return toast('Maksimal 6 jadwal per hari.');
    cfgDraft.schedules.push({ time: '18:00', grams: 50, enabled: true });
    renderSchedule();
  };
  $('#saveCfgBtn').onclick = saveSchedule;
  $('#saveSetBtn').onclick = saveSettings;
  document.querySelectorAll('.tabbtn').forEach(b => {
    b.onclick = () => {
      document.querySelectorAll('.tabbtn').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      logTab = b.dataset.tab;
      renderLogs();
    };
  });
}
function startClock() {
  const tick = () => {
    $('#clock').textContent = new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Jakarta' }) + ' WIB';
  };
  tick(); setInterval(tick, 1000);
}
function startSSE() {
  const es = new EventSource('/api/stream');
  es.onmessage = (ev) => {
    try {
      const m = JSON.parse(ev.data);
      if (!cur || m.device !== cur.id) return;
      if (m.type === 'telemetry' || m.type === 'status' || m.type === 'event') refreshDevice();
    } catch (e) { /* abaikan */ }
  };
  es.onerror = () => { /* EventSource retry otomatis */ };
}
async function loadDevice(id) {
  const st = await api('/api/status');
  devices = st.devices;
  cur = devices.find(d => d.id === id) || devices[0];
  if (!cur) return;
  cfgDraft = JSON.parse(JSON.stringify(cur.config));
  renderAll();
  refreshReport();
  refreshLogs();
}
async function refreshDevice() {
  if (!cur) return;
  const st = await api('/api/status');
  const d = st.devices.find(x => x.id === cur.id);
  if (!d) return;
  cur = d;
  renderHero();
}
function renderAll() {
  renderHero();
  renderSchedule();
  renderSettings();
  $('#mqttInfo').textContent = `MQTT: asta/lele/${cur.id}/telemetry · cmd · config · status`;
}
function renderHero() {
  $('#devName').textContent = cur.name;
  const rt = cur.telemetry;
  const pill = $('#statusPill');
  if (cur.online) {
    pill.className = 'pill on';
    $('#statusTxt').textContent = 'Online';
    $('#devSub').textContent = rt && rt.lastFeedAt
      ? `Terakhir beri pakan ${fmtDT(rt.lastFeedAt * 1000)} · ${rt.sessionsToday || 0} sesi hari ini`
      : 'Terhubung — belum ada sesi pakan hari ini.';
  } else {
    pill.className = 'pill off';
    $('#statusTxt').textContent = 'Offline';
    $('#devSub').textContent = cur.lastSeen
      ? `Terakhir terlihat ${fmtDT(cur.lastSeen)} — cek daya & WiFi unit.`
      : 'Unit belum pernah terhubung.';
  }
  $('#todayG').textContent = cur.today.totalG;
  $('#feedBtn').disabled = !cur.online;
  const nf = cur.nextFeed;
  $('#nextFeed').innerHTML = nf
    ? `Jadwal berikut: <b>${nf.time} WIB · ${nf.grams} g</b> (${nf.inMin < 60 ? nf.inMin + ' mnt lagi' : Math.floor(nf.inMin / 60) + ' jam ' + (nf.inMin % 60) + ' mnt lagi'})`
    : 'Tidak ada jadwal aktif berikutnya.';
  if (rt) {
    $('#telemetry').innerHTML =
      `<span>State: <b>${rt.state || '?'}</b></span>` +
      `<span>Sinyal: <b>${rt.rssi ?? '?'} dBm</b></span>` +
      `<span>Uptime: <b>${Math.floor((rt.uptimeSec || 0) / 60)} mnt</b></span>` +
      (rt.freeHeap ? `<span>Heap: <b>${Math.round(rt.freeHeap / 1024)} KB</b></span>` : '');
  } else {
    $('#telemetry').textContent = 'Menunggu telemetri device…';
  }
}
async function feedNow() {
  const grams = Math.max(1, Math.min(500, parseInt($('#feedGrams').value, 10) || 50));
  const btn = $('#feedBtn');
  btn.disabled = true;
  try {
    await api(`/api/device/${cur.id}/feed`, { method: 'POST', body: JSON.stringify({ grams }) });
    toast(`Perintah terkirim — ${grams} g pakan sedang diberikan.`);
    setTimeout(() => { refreshDevice(); refreshReport(); refreshLogs(); }, 2500);
  } catch (e) { toast(e.message, 3500); }
  btn.disabled = !cur.online;
}

// ---------- schedule ----------
function renderSchedule() {
  const daysEl = $('#days');
  daysEl.innerHTML = DAY_LABELS.map((lbl, i) => {
    const on = cfgDraft.activeDays.includes(i);
    return `<button type="button" class="daybtn${on ? ' on' : ''}" data-day="${i}">${lbl}</button>`;
  }).join('');
  daysEl.querySelectorAll('.daybtn').forEach(b => {
    b.onclick = () => {
      const d = parseInt(b.dataset.day, 10);
      const ix = cfgDraft.activeDays.indexOf(d);
      if (ix >= 0) cfgDraft.activeDays.splice(ix, 1); else cfgDraft.activeDays.push(d);
      renderSchedule();
    };
  });
  const slotsEl = $('#slots');
  slotsEl.innerHTML = cfgDraft.schedules.map((s, i) => `
    <div class="slot">
      <input type="time" value="${s.time}" data-i="${i}" data-f="time">
      <input type="number" min="1" max="500" value="${s.grams}" data-i="${i}" data-f="grams"> <span class="g">gram</span>
      <label class="switch"><input type="checkbox" ${s.enabled ? 'checked' : ''} data-i="${i}" data-f="enabled"> Aktif</label>
      <span class="spacer"></span>
      <button type="button" class="iconbtn danger" data-del="${i}">Hapus</button>
    </div>`).join('');
  slotsEl.querySelectorAll('input').forEach(inp => {
    inp.onchange = () => {
      const i = parseInt(inp.dataset.i, 10), f = inp.dataset.f;
      if (f === 'grams') cfgDraft.schedules[i].grams = Math.max(1, Math.min(500, parseInt(inp.value, 10) || 50));
      else if (f === 'time') cfgDraft.schedules[i].time = inp.value;
      else if (f === 'enabled') cfgDraft.schedules[i].enabled = inp.checked;
    };
  });
  slotsEl.querySelectorAll('[data-del]').forEach(b => {
    b.onclick = () => {
      if (cfgDraft.schedules.length <= 1) return toast('Minimal 1 jadwal.');
      cfgDraft.schedules.splice(parseInt(b.dataset.del, 10), 1);
      renderSchedule();
    };
  });
}
async function saveSchedule() {
  const btn = $('#saveCfgBtn');
  btn.disabled = true;
  $('#cfgMsg').textContent = '';
  try {
    const cfg = { ...cur.config, activeDays: cfgDraft.activeDays, schedules: cfgDraft.schedules };
    const r = await api(`/api/device/${cur.id}/config`, { method: 'POST', body: JSON.stringify({ config: cfg }) });
    cur.config = r.config; cur.nextFeed = r.nextFeed;
    cfgDraft = JSON.parse(JSON.stringify(r.config));
    $('#cfgMsg').textContent = 'Jadwal tersimpan & terkirim ke device.';
    $('#cfgMsg').className = 'okmsg';
    renderHero();
  } catch (e) {
    $('#cfgMsg').textContent = e.message;
    $('#cfgMsg').className = 'errmsg';
  }
  btn.disabled = false;
}

// ---------- settings ----------
function renderSettings() {
  $('#setName').value = cur.config.name;
  $('#setGps').value = cur.config.gramsPerSecond;
}
async function saveSettings() {
  const btn = $('#saveSetBtn');
  btn.disabled = true;
  $('#setMsg').textContent = '';
  try {
    const cfg = {
      ...cur.config,
      name: $('#setName').value.trim() || cur.config.name,
      gramsPerSecond: Math.max(1, Math.min(100, parseInt($('#setGps').value, 10) || 10)),
    };
    const r = await api(`/api/device/${cur.id}/config`, { method: 'POST', body: JSON.stringify({ config: cfg }) });
    cur.config = r.config;
    cfgDraft = JSON.parse(JSON.stringify(r.config));
    $('#devName').textContent = r.config.name;
    $('#setMsg').textContent = 'Pengaturan tersimpan & terkirim ke device.';
    $('#setMsg').className = 'okmsg';
  } catch (e) {
    $('#setMsg').textContent = e.message;
    $('#setMsg').className = 'errmsg';
  }
  btn.disabled = false;
}

// ---------- reports & logs ----------
async function refreshReport() {
  if (!cur) return;
  try {
    const r = await api(`/api/device/${cur.id}/report?range=today`);
    $('#stToday').textContent = r.totalG;
    $('#stTodayS').textContent = r.sessions + ' sesi';
    $('#stWeek').textContent = r.week.totalG;
    $('#stWeekS').textContent = r.week.sessions + ' sesi';
    $('#stMonth').textContent = r.month.totalG;
    $('#stMonthS').textContent = r.month.sessions + ' sesi';
    const max = Math.max(1, ...r.last7.map(d => d.grams));
    const todayKey = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
    $('#chart').innerHTML = r.last7.map(d => `
      <div class="bar-wrap">
        <div class="bar-val">${d.grams || ''}</div>
        <div class="bar${d.key === todayKey ? ' today' : ''}" style="height:${Math.max(4, Math.round((d.grams / max) * 96))}px"></div>
        <div class="bar-lbl">${d.label}</div>
      </div>`).join('');
  } catch (e) { /* abaikan */ }
}
let cachedFeed = [], cachedPower = [];
async function refreshLogs() {
  if (!cur) return;
  try {
    const f = await api(`/api/device/${cur.id}/events`);
    cachedFeed = f.events;
    const p = await api(`/api/device/${cur.id}/power`);
    cachedPower = p.power;
    renderLogs();
  } catch (e) { /* abaikan */ }
}
function renderLogs() {
  if (logTab === 'feed') {
    $('#logFeed').classList.remove('hidden');
    $('#logPower').classList.add('hidden');
    if (!cachedFeed.length) {
      $('#logFeed').innerHTML = '<p class="empty">Belum ada sesi pakan tercatat. Begitu device memberi pakan (jadwal/manual/remote), sesinya muncul di sini.</p>';
      return;
    }
    $('#logFeed').innerHTML = `<table class="log"><thead><tr><th>Waktu (WIB)</th><th>Gram</th><th>Pemicu</th><th>Catatan</th></tr></thead><tbody>${
      cachedFeed.map(e => `<tr><td class="mono">${fmtDT(e.ts)}</td><td><b>${e.grams || '—'} g</b></td><td><span class="badge ${e.trigger || ''}">${e.trigger || e.type}</span></td><td>${e.slot ? 'Slot ' + e.slot : (e.note || '')}</td></tr>`).join('')
    }</tbody></table>`;
  } else {
    $('#logPower').classList.remove('hidden');
    $('#logFeed').classList.add('hidden');
    if (!cachedPower.length) {
      $('#logPower').innerHTML = '<p class="empty">Belum ada riwayat hidup/mati. Device yang online akan tercatat saat pertama connect dan saat putus.</p>';
      return;
    }
    $('#logPower').innerHTML = `<table class="log"><thead><tr><th>Waktu (WIB)</th><th>Status</th><th>Via</th></tr></thead><tbody>${
      cachedPower.map(e => `<tr><td class="mono">${fmtDT(e.ts)}</td><td><span class="badge ${e.state}">${e.state === 'online' ? 'Hidup' : 'Mati'}</span></td><td>${e.via || ''}</td></tr>`).join('')
    }</tbody></table>`;
  }
}

boot().catch((e) => {
  document.body.innerHTML = '<div class="auth-wrap"><div class="auth-card"><h2>Server tidak bisa dihubungi</h2><p>' + e.message + '</p></div></div>';
});
