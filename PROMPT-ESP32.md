# PROMPT — Firmware ESP32 Alat Pemberi Makan Lele Otomatis (MQTT)

> Copy-paste seluruh prompt ini ke AI yang mengerjakan kode ESP32. Semua fakta broker di bawah ini sudah terverifikasi live pada 2026-11-18. Jangan mengubah kontrak topik/payload — server dashboard sudah dibangun mengikuti kontrak ini.

---

## 1. Peran & tugas

Kamu adalah firmware engineer ESP32. Tulis **satu file Arduino sketch lengkap** (`.ino`, siap compile di Arduino IDE 2.x) untuk ESP32-S3/C3 yang menjadi **otak alat pemberi makan lele otomatis**.

Alat ini: sebuah wadah pakan + mekanisme dispenser (servo yang memutar ulir/katup) di atas kolam lele. ESP32 terhubung WiFi, lalu ke broker MQTT kami, menerima jadwal dari dashboard web, memberi pakan otomatis sesuai jadwal, dan melaporkan setiap sesi pakan + status hidup/mati ke dashboard.

**Deliverable:**
1. Satu file `lele-feeder-esp32.ino` (lengkap, bukan pseudocode, bukan potongan).
2. Daftar library + versi yang dipakai.
3. Catatan wiring singkat (pin servo, LED, catu daya).
4. Contoh output Serial Monitor saat boot → connect → terima config → beri pakan 1x.

## 2. Broker MQTT kami (SUDAH JALAN, terverifikasi)

| Item | Nilai |
|---|---|
| Host | `IP_PUBLIK_BROKER_ANDA` (IP publik broker MQTT kamu; port 1883 harus bisa dijangkau device dari internet) |
| Port MQTT | `1883`, TCP polos — **TANPA TLS**. Jangan pakai `WiFiClientSecure`, jangan set CA cert. |
| Port WebSocket | `9001` (tidak dipakai firmware — hanya info) |
| Broker | Mosquitto 2.1.2 (Docker `asta-mosquitto`, `restart=always`, persistence aktif) |
| Auth | **Wajib username + password** (anonymous ditolak — CONNECT tanpa kredensial dibalas CONNACK `0x05` not authorized) |
| Username device | `lele-esp32-01` |
| Password device | **TIDAK ADA di prompt ini.** Isi placeholder `MQTT_PASS` di sketch dari file `/srv/lele-feeder/.env` di VPS (key `ESP_MQTT_PASS`). **Jangan pernah menulis password asli di kode, di chat, atau di commit git.** |
| Client ID | `lele-01` (tetap — 1 device = 1 ID; jangan pakai random suffix, supaya dashboard bisa membedakan device) |
| Keepalive | 60 detik |

## 3. Kontrak topik (WAJIB diikuti persis — jangan ganti nama/format)

Base: `asta/lele/lele-01/` — ganti `lele-01` dengan `DEVICE_ID` di sketch (default `lele-01`).

### 3a. Device → Server (publish)

| Topik | Retain | QoS | Payload (JSON) | Kapan |
|---|---|---|---|---|
| `asta/lele/lele-01/telemetry` | tidak | 1 | `{"ts": 1794999xxx, "state": "idle"/"feeding", "feedTodayG": 120, "sessionsToday": 2, "lastFeedAt": 1794999xxx, "nextFeedAt": 1794999xxx, "uptimeSec": 3600, "rssi": -62, "freeHeap": 123456}` | tiap 30 detik + tiap ada perubahan state |
| `asta/lele/lele-01/event` | tidak | 1 | `{"ts": ..., "type": "feed", "grams": 60, "trigger": "jadwal"/"manual"/"remote", "slot": "07:00"}` (trigger `jadwal` = dari jadwal otomatis; `remote` = perintah dari dashboard; `manual` = tombol fisik bila ada) | tiap selesai 1 sesi pakan |
| `asta/lele/lele-01/event` | tidak | 1 | `{"ts": ..., "type": "power", "note": "boot"}` | sekali saat boot (setelah WiFi+MQTT connect) |
| `asta/lele/lele-01/event` | tidak | 1 | `{"ts": ..., "type": "config", "note": "config applied"}` | tiap config baru diterima & disimpan |
| `asta/lele/lele-01/status` | **YA** | 1 | `online` / `offline` (string polos, bukan JSON) | `online` sebagai birth message saat connect; `offline` sebagai **LWT** (Last Will) — set saat CONNECT |

- Semua `ts` = **Unix epoch detik (UTC)**. Waktu lokal WIB (UTC+7) hanya untuk log Serial & perhitungan jadwal.
- `feedTodayG` & `sessionsToday` dihitung device per hari WIB (reset jam 00:00 WIB). Server juga menghitung ulang dari event — angka device dipakai untuk tampil di kartu status, angka server untuk laporan resmi.

### 3b. Server → Device (subscribe)

| Topik | Retain | Payload (JSON) |
|---|---|---|
| `asta/lele/lele-01/cmd` | tidak | `{"action": "feed_now", "grams": 50, "requestId": "abc123"}` → beri pakan sekarang sebanyak `grams` gram, lalu publish `event` type `feed`, trigger `remote`. <br>`{"action": "reboot"}` → restart ESP32. <br>`{"action": "ping"}` → balas dengan publish `telemetry` sekali. |
| `asta/lele/lele-01/config` | **YA** | Config lengkap (lihat §4). Terima → simpan ke Preferences → pakai langsung → publish `event` type `config`. Karena retained, device baru boot langsung dapat config terakhir. |

## 4. Model config (JSON, dari dashboard)

```json
{
  "id": "lele-01",
  "name": "Kolam Lele 01",
  "activeDays": [1, 2, 3, 4, 5, 6, 0],
  "schedules": [
    { "time": "07:00", "grams": 60, "enabled": true },
    { "time": "12:00", "grams": 60, "enabled": true },
    { "time": "17:00", "grams": 80, "enabled": true }
  ],
  "gramsPerSecond": 10
}
```

- `activeDays`: hari aktif, format `getDay()` JavaScript — `0` = Minggu, `1` = Senin, … `6` = Sabtu. Default: semua hari aktif.
- `schedules`: maks 6 slot. `time` format `HH:MM` (WIB). `grams` 1–500.
- `gramsPerSecond`: kalibrasi — 1 detik putaran servo = sekian gram pakan. Default `10`. Dipakai untuk menghitung durasi: `durasiDetik = grams / gramsPerSecond`.
- Simpan config di **Preferences (NVS)** supaya jadwal tetap jalan walau broker/server mati. Config dari MQTT (retained) selalu menang atas yang tersimpan bila lebih baru.

## 5. Perilaku wajib firmware

1. **Boot**: WiFi connect (tunggu max 20 detik, lalu retry) → NTP sync (`pool.ntp.org`, GMT+7, cek `configTime(7*3600, 0, ...)`) → MQTT connect (dengan LWT `status` = `offline`, retained) → publish birth `status` = `online` + `event` type `power` note `boot` → subscribe `cmd` + `config` → publish `telemetry`.
2. **Jadwal jalan di device** (bukan di server): tiap loop cek waktu WIB; bila hari ini ada di `activeDays` DAN jam:menit cocok dengan slot yang `enabled` DAN slot itu belum dieksekusi hari ini (tandai per slot per tanggal — mis. `lastFedDate[slot]`) → beri pakan. Jendela toleransi ±1 menit. **Satu slot hanya boleh dieksekusi 1x per hari** (anti double-feed saat reboot di tengah slot).
3. **Beri pakan** = putar servo dispenser selama `durasiDetik` (dari `grams / gramsPerSecond`, minimal 1 detik, maksimal 60 detik per sesi). Selama feeding, `state` = `feeding`; setelah selesai kembali `idle`, update `feedTodayG`/`sessionsToday`/`lastFeedAt`, publish `event` + `telemetry`.
4. **Reconnect mandiri**: bila WiFi putus → reconnect WiFi (backoff 5 detik); bila MQTT putus → reconnect MQTT (backoff 5 detik, max 10x lalu restart WiFi). **Jangan pernah `ESP.restart()` di loop reconnect** kecuali sudah 5 menit tidak bisa connect sama sekali. Jadwal yang terlewat saat offline **tidak dikejar** (tidak ada catch-up feed — lele tidak boleh diberi pakan dobel).
5. **Non-blocking**: jangan pakai `delay()` panjang di `loop()`. Servo jalan dengan state machine berbasis `millis()`. `mqttClient.loop()` harus dipanggil tiap iterasi.
6. **Hemat daya & stabil**: `setCpuFrequencyMhz(80)` boleh; matikan Bluetooth (tidak dipakai). Watchdog: `yield()`/beri waktu ke sistem di loop panjang.

## 6. Hardware (asumsi — nyatakan bila kamu mengubahnya)

- Board: ESP32-S3 atau ESP32-C3 (DevKit, Arduino core ESP32 v3.x).
- Servo dispenser: **GPIO 13** (PWM), posisi diam 0°, posisi putar 90° selama feeding (kalau mekanismenya ulir kontinyu, pakai servo continuous / motor DC + driver — tulis di catatan mana yang kamu asumsikan).
- LED status: **GPIO 2** (nyala = online MQTT, kedip cepat = feeding, kedip lambat = reconnecting).
- Tombol manual (opsional, bila ada): **GPIO 0** (BOOT) ditekan 1 detik = beri pakan 1 porsi default (50 g, trigger `manual`).
- Catu daya: 5V 2A (servo jangan ambil daya dari pin 5V board saat beban — pakai regulator terpisah; tulis peringatan ini di catatan wiring).
- Semua pin **wajib konstanta bernama di atas sketch** (`SERVO_PIN`, `LED_PIN`, `BTN_PIN`) supaya gampang diubah.

## 7. Library (Arduino IDE Library Manager)

- `PubSubClient` by Nick O'Leary (v2.8) — MQTT.
- `ArduinoJson` by Benoît Blanchon (v7.x) — parse config/cmd, bangun telemetry/event.
- `ESP32Servo` by Kevin Harrington (bila servo standar) — sebutkan bila kamu pakai alternatif.
- **Jangan** pakai library MQTT lain (mis. AsyncMqttClient) tanpa alasan — PubSubClient sudah cukup dan paling mudah diverifikasi.

## 8. Yang TIDAK BOLEH dilakukan

- Jangan pakai TLS / `WiFiClientSecure` — broker kami port 1883 polos.
- Jangan hardcode password WiFi/MQTT asli di sketch — pakai placeholder `WIFI_SSID`, `WIFI_PASS`, `MQTT_PASS` di blok config atas, dengan komentar "ISI SEBELUM FLASH".
- Jangan ubah nama topik / format payload §3 — dashboard sudah mengikuti kontrak ini.
- Jangan beri pakan dobel: tanpa dedup per-slot-per-hari, dan tanpa catch-up jadwal yang terlewat.
- Jangan publish telemetry lebih sering dari 10 detik (spam) atau lebih jarang dari 60 detik (dashboard mengira mati).
- Jangan simpan password di Preferences / SPIFFS.

## 9. Acceptance checklist (uji sebelum diserahkan)

- [ ] Compile bersih di Arduino IDE (board ESP32-S3/C3, tanpa warning error).
- [ ] Boot → Serial menunjukkan: WiFi OK → NTP OK (jam WIB benar) → MQTT OK → `status online` terkirim.
- [ ] Dashboard (atau `mosquitto_sub`) melihat `telemetry` tiap 30 detik dengan angka yang masuk akal.
- [ ] Kirim `cmd feed_now 50` → servo berputar ±5 detik (50 g / 10 g/dtk) → `event` type `feed`, trigger `remote`, grams 50 muncul.
- [ ] Kirim `config` baru (ubah jam slot) → device simpan, publish `event` type `config`, jadwal baru dipakai; reboot device → config tetap (Preferences).
- [ ] Matikan WiFi 2 menit → device reconnect sendiri, tidak double-feed, tidak restart liar.
- [ ] Cabut daya di tengah slot jadwal → nyalakan lagi 5 menit kemudian → slot itu TIDAK dieksekusi 2x hari itu.
- [ ] LWT bekerja: cabut daya mendadak → broker menerbitkan `status offline` (cek via subscriber).

## 10. Konteks proyek (supaya bahasanya nyambung)

Pemilik: Bung Asta (ASTA Group, Mojokerto). Bahasa: Indonesia. Dashboard: `lele.astastore.id` (server Node di VPS, user MQTT `lele-server`). Proyek: "LeleFeeder Remote" — dashboard + server + firmware ini satu paket; firmware kamu adalah sisi device-nya.
