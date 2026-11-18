# LeleFeeder Remote

Dashboard web untuk me-remote alat pemberi makan lele otomatis. Otaknya ESP32 yang
terhubung ke broker MQTT; dashboard ini mengatur jadwal, memicu pakan manual,
dan menampilkan laporan pakan + status hidup/mati unit.

- **Dashboard:** Node.js (tanpa framework) + MQTT, password gate (setup saat kunjungan pertama)
- **Firmware:** Arduino sketch ESP32 (`firmware/lele-feeder-esp32.ino`)
- **Prompt AI:** `PROMPT-ESP32.md` — prompt siap copy-paste untuk AI yang menulis firmware ESP32-nya
- **Simulator:** `simulator/sim-device.js` — device virtual untuk testing tanpa hardware

## Fitur

- Atur hari aktif (Sen–Min) per unit
- Jadwal pakan sampai 6 slot/hari (jam + gram per sesi, bisa on/off per slot)
- Tombol **Beri Pakan Sekarang** (dengan input gram)
- Laporan pakan: hari ini / minggu ini / bulan ini (gram + jumlah sesi), chart batang 7 hari, tabel tiap sesi (jam, gram, pemicu: jadwal/manual/remote)
- Laporan hidup/mati unit (dari LWT broker MQTT)
- Pengaturan unit: nama + kalibrasi gram per detik putaran servo

Jadwal dieksekusi **di device** (NTP + penyimpanan Preferences), jadi pakan tetap
jalan walau server atau broker mati. Server hanya mirror config, trigger manual,
dan laporan.

## Kontrak MQTT

Base topic: `asta/lele/<deviceId>/`

| Arah | Topic | Isi |
| --- | --- | --- |
| Device → server | `telemetry` | JSON `{ts, state, feedTodayG, sessionsToday, lastFeedAt, nextFeedAt, uptimeSec, rssi, freeHeap}` tiap 30 dtk |
| Device → server | `event` | JSON `{ts, type: feed\|power\|config, grams, trigger: jadwal\|manual\|remote, slot, note}` |
| Device → server | `status` | LWT retained, string `online` / `offline` |
| Server → device | `cmd` | `{action: feed_now, grams, requestId}` / `set_config` / `reboot` / `ping` |
| Server → device | `config` | Retained, config JSON lengkap |

Config default: aktif Sen–Min; 07:00/60 g, 12:00/60 g, 17:00/80 g; 10 g/detik.

## Cara jalan (server)

```bash
cp .env.example .env   # lalu isi kredensial MQTT kamu
npm install
node server.js         # listen 127.0.0.1:3102
```

Buka `http://localhost:3102`, buat password saat kunjungan pertama.
Data tersimpan lokal di `data/` (config, event log, auth) — jangan di-commit.

Contoh nginx reverse proxy ada di `lele-nginx.conf`.

## Cara flash (ESP32)

1. Buka `firmware/lele-feeder-esp32.ino` di Arduino IDE.
2. Isi blok config di atas: `WIFI_SSID`, `WIFI_PASS`, `MQTT_HOST` (IP publik broker
   MQTT kamu), `MQTT_PASS` (password user device dari `.env`, key `ESP_MQTT_PASS`).
3. Install library: PubSubClient 2.8, ArduinoJson 7.x, ESP32Servo.
4. Flash ke ESP32. Wiring: servo GPIO 13, LED GPIO 2, tombol manual GPIO 0.

Detail lengkap + checklist penerimaan ada di `PROMPT-ESP32.md`.

## Testing tanpa hardware

```bash
node simulator/sim-device.js   # butuh .env (baca ESP_MQTT_USER / ESP_MQTT_PASS)
```

Simulator connect sebagai `lele-01`, terima config, dan merespons perintah pakan.
Setelah testing, kosongkan `data/events.jsonl` + `data/power.jsonl` supaya laporan
mulai dari nol.

## Keamanan

- Jangan pernah commit `.env`, `data/`, atau password asli. Pakai placeholder
  (`IP_PUBLIK_BROKER_ANDA`, `ISI_...`) di semua file yang di-commit.
- Broker MQTT tanpa TLS — batasi user per device dan jangan pakai password yang
  sama dengan layanan lain.
