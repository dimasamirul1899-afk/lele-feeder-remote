// LeleFeeder ESP32 — alat pemberi makan lele otomatis (firmware device)
// Kontrak MQTT: lihat PROMPT-ESP32.md / design-brief.md di repo lele-feeder.
// Board: ESP32-S3/C3, Arduino core ESP32 v3.x
// Library: PubSubClient 2.8, ArduinoJson 7.x, ESP32Servo
#include <WiFi.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <ESP32Servo.h>
#include <time.h>

// ===================== ISI SEBELUM FLASH =====================
const char* WIFI_SSID     = "NAMA_WIFI";
const char* WIFI_PASS     = "PASSWORD_WIFI";
const char* MQTT_HOST     = "IP_PUBLIK_BROKER_ANDA";  // IP publik broker MQTT (port 1883, TANPA TLS) — ISI SEBELUM FLASH
const uint16_t MQTT_PORT  = 1883;
const char* MQTT_USER     = "lele-esp32-01";
const char* MQTT_PASS     = "ISI_DARI_/srv/lele-feeder/.env (ESP_MQTT_PASS)";
const char* DEVICE_ID     = "lele-01";
// =============================================================

const int SERVO_PIN = 13;
const int LED_PIN   = 2;
const int BTN_PIN   = 0;   // BOOT button: tekan 1 detik = pakan manual 50 g

WiFiClient wifiClient;
PubSubClient mqtt(wifiClient);
Preferences prefs;
Servo feederServo;

String baseTopic() { return String("asta/lele/") + DEVICE_ID + "/"; }

// ---------- config ----------
struct Slot { String time; int grams; bool enabled; };
const int MAX_SLOTS = 6;
String devName = "Kolam Lele 01";
int activeDays[7] = {1,2,3,4,5,6,0}; int nActiveDays = 7;
Slot slots[MAX_SLOTS]; int nSlots = 3;
int gramsPerSecond = 10;
String lastFedKey[MAX_SLOTS]; // "YYYY-MM-DD" per slot, anti double-feed

// ---------- runtime ----------
unsigned long feedTodayG = 0, sessionsToday = 0;
unsigned long lastFeedAt = 0, bootAt = 0;
String todayKey = "";
bool feeding = false;
unsigned long feedEndMs = 0;
int feedGramsNow = 0;
String feedTriggerNow = "";
String feedSlotNow = "";
unsigned long lastTelemetryMs = 0, lastNtpCheckMs = 0;
unsigned long btnPressMs = 0;
bool ledState = false;

String wibDateKey(time_t t) {
  struct tm tmv; gmtime_r(&t, &tmv); // t sudah +7 jam (lihat nowWib)
  char b[11]; strftime(b, sizeof b, "%Y-%m-%d", &tmv);
  return String(b);
}
time_t nowWib() { return time(nullptr) + 7 * 3600; }
String hhmm(time_t t) {
  struct tm tmv; gmtime_r(&t, &tmv);
  char b[6]; strftime(b, sizeof b, "%H:%M", &tmv);
  return String(b);
}
int wibDow(time_t t) { struct tm tmv; gmtime_r(&t, &tmv); return tmv.tm_wday; } // 0=Min..6=Sab

void saveConfig() {
  prefs.begin("lele", false);
  prefs.putString("name", devName);
  prefs.putInt("gps", gramsPerSecond);
  prefs.putInt("nslots", nSlots);
  String ad = "";
  for (int i = 0; i < nActiveDays; i++) { if (i) ad += ","; ad += String(activeDays[i]); }
  prefs.putString("days", ad);
  for (int i = 0; i < nSlots; i++) {
    prefs.putString(("t" + String(i)).c_str(), slots[i].time);
    prefs.putInt(("g" + String(i)).c_str(), slots[i].grams);
    prefs.putBool(("e" + String(i)).c_str(), slots[i].enabled);
  }
  prefs.end();
}
void loadConfig() {
  prefs.begin("lele", true);
  devName = prefs.getString("name", devName);
  gramsPerSecond = prefs.getInt("gps", gramsPerSecond);
  int ns = prefs.getInt("nslots", 0);
  if (ns > 0 && ns <= MAX_SLOTS) {
    nSlots = ns;
    for (int i = 0; i < nSlots; i++) {
      slots[i].time = prefs.getString(("t" + String(i)).c_str(), "07:00");
      slots[i].grams = prefs.getInt(("g" + String(i)).c_str(), 50);
      slots[i].enabled = prefs.getBool(("e" + String(i)).c_str(), true);
    }
  } else {
    slots[0] = {"07:00", 60, true}; slots[1] = {"12:00", 60, true}; slots[2] = {"17:00", 80, true};
  }
  String ad = prefs.getString("days", "1,2,3,4,5,6,0");
  nActiveDays = 0;
  int start = 0;
  for (int i = 0; i <= ad.length(); i++) {
    if (i == ad.length() || ad[i] == ',') {
      if (nActiveDays < 7) activeDays[nActiveDays++] = ad.substring(start, i).toInt();
      start = i + 1;
    }
  }
  prefs.end();
}
bool dayActive(int dow) {
  for (int i = 0; i < nActiveDays; i++) if (activeDays[i] == dow) return true;
  return false;
}

void publishTelemetry() {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  time_t now = time(nullptr);
  doc["ts"] = (long)now;
  doc["state"] = feeding ? "feeding" : "idle";
  doc["feedTodayG"] = feedTodayG;
  doc["sessionsToday"] = sessionsToday;
  doc["lastFeedAt"] = (long)lastFeedAt;
  // next feed: hitung slot berikut (sederhana: slot enabled pertama hari ini yang belum lewat)
  doc["uptimeSec"] = (long)((millis() - bootAt) / 1000);
  doc["rssi"] = WiFi.RSSI();
  doc["freeHeap"] = ESP.getFreeHeap();
  String out; serializeJson(doc, out);
  mqtt.publish((baseTopic() + "telemetry").c_str(), out.c_str(), false);
}
void publishEvent(const char* type, int grams, const char* trigger, const char* slot, const char* note) {
  if (!mqtt.connected()) return;
  JsonDocument doc;
  doc["ts"] = (long)time(nullptr);
  doc["type"] = type;
  if (grams >= 0) doc["grams"] = grams;
  if (trigger) doc["trigger"] = trigger;
  if (slot) doc["slot"] = slot;
  if (note) doc["note"] = note;
  String out; serializeJson(doc, out);
  mqtt.publish((baseTopic() + "event").c_str(), out.c_str(), false);
}

void startFeed(int grams, const char* trigger, const char* slot) {
  if (feeding) return;
  int durSec = grams / max(1, gramsPerSecond);
  durSec = constrain(durSec, 1, 60);
  feeding = true; feedGramsNow = grams; feedTriggerNow = trigger; feedSlotNow = slot ? slot : "";
  feedEndMs = millis() + (unsigned long)durSec * 1000UL;
  feederServo.write(90); // putar dispenser
  Serial.printf("[FEED] mulai %d g (%d dtk) trigger=%s slot=%s\n", grams, durSec, trigger, feedSlotNow.c_str());
  publishTelemetry();
}
void finishFeed() {
  feeding = false;
  feederServo.write(0); // diam
  feedTodayG += feedGramsNow; sessionsToday++;
  lastFeedAt = time(nullptr);
  Serial.printf("[FEED] selesai %d g\n", feedGramsNow);
  publishEvent("feed", feedGramsNow, feedTriggerNow.c_str(), feedSlotNow.isEmpty() ? nullptr : feedSlotNow.c_str(), nullptr);
  publishTelemetry();
}

void applyConfigJson(const char* payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) { Serial.println("[CFG] JSON tidak valid"); return; }
  if (doc["name"].is<const char*>()) devName = doc["name"].as<String>();
  if (doc["gramsPerSecond"].is<int>()) gramsPerSecond = constrain(doc["gramsPerSecond"].as<int>(), 1, 100);
  if (doc["activeDays"].is<JsonArray>()) {
    nActiveDays = 0;
    for (int d : doc["activeDays"].as<JsonArray>()) if (nActiveDays < 7) activeDays[nActiveDays++] = d;
  }
  if (doc["schedules"].is<JsonArray>()) {
    nSlots = 0;
    for (JsonObject s : doc["schedules"].as<JsonArray>()) {
      if (nSlots >= MAX_SLOTS) break;
      slots[nSlots].time = s["time"].as<String>();
      slots[nSlots].grams = constrain(s["grams"].as<int>(), 1, 500);
      slots[nSlots].enabled = s["enabled"].as<bool>();
      nSlots++;
    }
  }
  saveConfig();
  Serial.println("[CFG] config baru disimpan & dipakai");
  publishEvent("config", -1, nullptr, nullptr, "config applied");
  publishTelemetry();
}

void onMqtt(char* topic, byte* payload, unsigned int len) {
  String t = String(topic);
  String msg; msg.reserve(len + 1);
  for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
  Serial.printf("[MQTT] %s <- %s\n", t.c_str(), msg.c_str());
  if (t == baseTopic() + "config") { applyConfigJson(msg.c_str()); return; }
  if (t == baseTopic() + "cmd") {
    JsonDocument doc;
    if (deserializeJson(doc, msg.c_str())) return;
    String action = doc["action"].as<String>();
    if (action == "feed_now") {
      int g = constrain(doc["grams"].as<int>(), 1, 500);
      startFeed(g, "remote", nullptr);
    } else if (action == "set_config") {
      String cfg; serializeJson(doc["config"], cfg);
      applyConfigJson(cfg.c_str());
    } else if (action == "reboot") {
      Serial.println("[CMD] reboot...");
      delay(300); ESP.restart();
    } else if (action == "ping") {
      publishTelemetry();
    }
  }
}

void mqttConnect() {
  mqtt.setServer(MQTT_HOST, MQTT_PORT);
  mqtt.setCallback(onMqtt);
  String willTopic = baseTopic() + "status";
  // LWT: offline (retained) bila device mati mendadak
  mqtt.setBufferSize(2048);
  int tries = 0;
  while (!mqtt.connected() && tries < 5) {
    Serial.print("[MQTT] connect...");
    // clientId tetap DEVICE_ID; clean session true; will = offline retained
    if (mqtt.connect(DEVICE_ID, MQTT_USER, MQTT_PASS, willTopic.c_str(), 1, true, "offline")) {
      Serial.println(" OK");
      mqtt.subscribe((baseTopic() + "cmd").c_str(), 1);
      mqtt.subscribe((baseTopic() + "config").c_str(), 1);
      mqtt.publish(willTopic.c_str(), "online", true); // birth
      publishEvent("power", -1, nullptr, nullptr, "boot");
      publishTelemetry();
    } else {
      Serial.printf(" GAGAL rc=%d\n", mqtt.state());
      delay(5000); tries++;
    }
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  Serial.println("\n[LELE] boot");
  bootAt = millis();
  pinMode(LED_PIN, OUTPUT);
  pinMode(BTN_PIN, INPUT_PULLUP);
  feederServo.setPeriodHertz(50);
  feederServo.attach(SERVO_PIN, 500, 2400);
  feederServo.write(0);
  loadConfig();

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("[WIFI] connect");
  int w = 0;
  while (WiFi.status() != WL_CONNECTED && w < 40) { delay(500); Serial.print("."); w++; }
  Serial.println(WiFi.status() == WL_CONNECTED ? " OK" : " GAGAL");
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WIFI] IP "); Serial.println(WiFi.localIP());
    configTime(7 * 3600, 0, "pool.ntp.org", "time.google.com");
    Serial.print("[NTP] sync");
    time_t now = 0; int n = 0;
    while (now < 1700000000 && n < 20) { delay(500); now = time(nullptr); Serial.print("."); n++; }
    Serial.println();
    todayKey = wibDateKey(nowWib());
  }
  mqttConnect();
}

void checkSchedule() {
  if (feeding) return;
  time_t now = time(nullptr);
  if (now < 1700000000) return; // NTP belum sync
  time_t w = nowWib();
  String dk = wibDateKey(w);
  if (dk != todayKey) { // hari baru WIB: reset hitungan
    todayKey = dk; feedTodayG = 0; sessionsToday = 0;
    for (int i = 0; i < MAX_SLOTS; i++) lastFedKey[i] = "";
  }
  if (!dayActive(wibDow(w))) return;
  String nowHM = hhmm(w);
  for (int i = 0; i < nSlots; i++) {
    if (!slots[i].enabled) continue;
    if (slots[i].time != nowHM) continue;
    if (lastFedKey[i] == dk) continue; // sudah dieksekusi hari ini
    lastFedKey[i] = dk;
    startFeed(slots[i].grams, "jadwal", slots[i].time.c_str());
    return;
  }
}

void loop() {
  // WiFi reconnect
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("[WIFI] putus, reconnect...");
    WiFi.reconnect();
    delay(5000);
    return;
  }
  if (!mqtt.connected()) {
    Serial.println("[MQTT] putus, reconnect...");
    mqttConnect();
    delay(2000);
    return;
  }
  mqtt.loop();

  // tombol manual (tekan 1 detik)
  if (digitalRead(BTN_PIN) == LOW) {
    if (btnPressMs == 0) btnPressMs = millis();
    if (millis() - btnPressMs > 1000 && !feeding) {
      btnPressMs = 0;
      while (digitalRead(BTN_PIN) == LOW) delay(50); // tunggu lepas
      startFeed(50, "manual", nullptr);
    }
  } else btnPressMs = 0;

  if (feeding && millis() >= feedEndMs) finishFeed();
  checkSchedule();

  // LED status: nyala=online, kedip cepat=feeding
  unsigned long nowMs = millis();
  if (feeding) { digitalWrite(LED_PIN, (nowMs / 150) % 2 ? HIGH : LOW); }
  else digitalWrite(LED_PIN, HIGH);

  // telemetri 30 detik
  if (nowMs - lastTelemetryMs > 30000UL) { lastTelemetryMs = nowMs; publishTelemetry(); }
  delay(50);
}
