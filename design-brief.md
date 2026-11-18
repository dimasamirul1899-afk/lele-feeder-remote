# Design Brief — LeleFeeder Remote (lele.astastore.id)

## One-sentence intent
Dashboard remote untuk alat pemberi makan lele otomatis: pemilik kolam bisa mengatur hari aktif + jadwal pakan, memencet "beri pakan sekarang" dari mana saja, dan melihat laporan pakan (hari/minggu/bulan) serta riwayat hidup-mati unit — sekilas terbaca dari tepi kolam.

## Audience + context
Bung Asta, pemilik kolam lele. Dipakai dari HP di dekat kolam (siang terik, layar kecil) dan dari laptop. Satu unit dulu (`lele-01`), arsitektur siap multi-unit.

## Design DNA
Praktis, segar, terbaca: **air kolam** (teal dalam), **pakan** (amber), **angka besar yang jujur**. Bukan dashboard enterprise yang dingin, bukan pula toko yang ramai.

## 3 directions (dieksplorasi, dipilih #3)
1. **Pond Command (dark console)** — charcoal + teal glow, padat data. Kuat di malam hari, tapi berat dibaca di bawah matahari dan terasa seperti NOC.
2. **Kolam Pagi (light editorial)** — aqua muda, serif display, kartu longgar. Ramah, tapi jadwal + log jadi terasa seperti artikel, bukan alat kontrol.
3. **Bento Kontrol (dipilih)** — grid bento asimetris, kartu status besar + tombol aksi dominan, angka statistik raksasa, chart batang 7 hari dari div. Alasan: kontennya campuran (status, aksi, statistik, jadwal, log) dan bento memberi tiap jenis konten ukuran yang pantas; tombol "Beri Pakan" bisa jadi hero yang tak mungkin salah pencet.

## Archetype + tokens (baru — tidak dipakai 3 situs terakhir)
- Archetype: **bento-pond (NEW)** — bento grid + pond palette. Terakhir dipakai: thread-atelier, bento-pop (rose), pastel-playful — tidak ada yang bentrok.
- Display: **Bricolage Grotesque** (belum pernah dipakai) + body **Plus Jakarta Sans** + mono **JetBrains Mono** (angka telemetri).
- Tokens:
  - `--bg: #eef6f3` (aqua-tinted off-white), `--surface: #fbfdfc`, `--ink: #0b2e2b` (deep teal-ink), `--muted: #5b7a76`
  - `--accent: #f59e0b` (amber pakan — SATU aksen), `--teal: #0e7490`, `--deep: #134e4a`, `--line: #d3e4de`
  - `--radius: 20px` (kartu), tombol aksi radius penuh; tanpa gradient generik.
- Signature element: tombol **"Beri Pakan Sekarang"** bulat besar amber + cincin progres hitung mundur ke jadwal berikut; angka "Pakan hari ini" raksasa di kartu hero.

## Layout families (≥3)
1. Hero bento: status unit + tombol aksi + next feed countdown.
2. Strip statistik: 3 angka raksasa (hari ini / minggu ini / bulan ini) + chart batang 7 hari.
3. Panel jadwal: toggle hari Sen–Min + slot jam/gram yang bisa diedit.
4. Log tabel: sesi pakan + riwayat hidup/mati (dua tab).

## Kontrak MQTT (final)
- Base: `asta/lele/<device>/` — broker Mosquitto VPS (1883, auth on, no TLS).
- Device → server: `telemetry` (30 dtk: state, feedTodayG, sessionsToday, lastFeedAt, nextFeedAt, uptimeSec, rssi), `event` ({ts, type: feed|power|config, grams, trigger: jadwal|manual|remote}), `status` LWT retained online/offline.
- Server → device: `cmd` ({action: feed_now|set_config|reboot|ping}), `config` retained (jadwal + hari aktif + kalibrasi).
- Jadwal dieksekusi DI DEVICE (NTP + config tersimpan) supaya tetap jalan walau server/broker sempat mati. Server hanya mirror + trigger manual + laporan.

## Config per device
`{id, name, activeDays[0=Min..6=Sab], schedules[{time, grams, enabled}], gramsPerSecond}`.
Default lele-01: Sen–Min aktif, 07:00/60g, 12:00/60g, 17:00/80g, 10 g/detik.

## Laporan
Dari `events.jsonl` (WIB): hari ini, minggu ini (Sen–Min), bulan ini — total gram + jumlah sesi; log sesi (50 terakhir); log hidup/mati (LWT + power event). Semua angka dari event nyata, bukan estimasi.

## Keamanan
- Dashboard: password gate (setup saat kunjungan pertama, scrypt) — pola sama seperti malika-chat/video-studio.
- MQTT: user terpisah `lele-server` + `lele-esp32-01` (password di VPS .env 0600, tidak pernah tampil di chat).
- Server jalan di VPS (pm2 `lele-feeder` :3102) → nginx `lele.astastore.id` (443, self-signed origin) → Cloudflare proxied.

## Anti-goals
Bukan toko, bukan landing page, bukan demo statis. Tidak ada harga fiktif, tidak ada data dummy di laporan — sebelum ada device nyata, laporan menunjukkan "belum ada sesi" (simulator hanya untuk testing, datanya dibersihkan sebelum serah terima).

## Pre-flight
- [x] brief ditulis sebelum kode
- [x] archetype+palet baru (cek used-archetypes.md)
- [x] satu aksen, tanpa hitam/putih murni, tanpa gradient generik
- [ ] ≥3 layout families, hero muat viewport, signature element ada
- [ ] semua angka laporan dari event nyata
- [ ] mobile: no overflow, tap target ≥44px
