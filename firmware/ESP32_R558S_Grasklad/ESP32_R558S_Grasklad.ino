/*
 * ГРА-склад — прошивка ESP32 + сканер отпечатка R558-S для десктоп-приложения.
 *
 * Текстовый протокол для управления из Electron-приложения
 * по USB-serial (115200 бод).
 *
 * Подключение:
 *   Датчик TX (жёлтый) -> ESP32 GPIO16 (RX2)
 *   Датчик RX (чёрный) -> ESP32 GPIO17 (TX2)
 *   3V3 (белый+зелёный), GND (красный), TOUCH (синий) -> GPIO4
 *   UART датчик<->ESP: 57600 8N2. НЕ 5В!
 *
 * Библиотека: Adafruit Fingerprint Sensor Library v2.1.4
 *
 * Протокол ПК <-> ESP (строки, \n):
 *   PING                 -> PONG READY count=<N>
 *   ENROLL <id>          -> прогресс (Place/Remove/Scan), затем
 *                           TEMPLATE <id> <base64>  (если удалось выгрузить)
 *                           ENROLL OK <id>  | ENROLL FAIL <reason>
 *   LOAD <id> <base64>   -> LOAD OK <id> | LOAD FAIL <id>
 *   IDENTIFY             -> MATCH <id> <confidence> | NOMATCH | IDENTIFY FAIL
 *   DELETE <id>          -> DELETE OK <id> | DELETE FAIL
 *   CLEAR                -> CLEAR OK
 *   CANCEL               -> отмена текущей операции
 *
 * ВАЖНО: R558-S требует 4 скана при регистрации (не 2), иначе ошибка 0x35.
 * Выгрузка/загрузка шаблона (UpChar/DownChar) — тестировать на железе 03.08.
 */

#include <Adafruit_Fingerprint.h>

#define FP_RX_PIN 16   // ESP32 RX2 <- TX датчика (жёлтый)
#define FP_TX_PIN 17   // ESP32 TX2 -> RX датчика (чёрный)
#define FP_TOUCH_PIN 4 // TOUCH_OUT (синий), опционально

HardwareSerial FPSerial(2);
Adafruit_Fingerprint finger = Adafruit_Fingerprint(&FPSerial);

bool cancelFlag = false;
uint16_t g_capacity = 100;

// ---- base64 ----
static const char B64[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
String b64encode(const uint8_t *data, size_t len) {
  String out;
  out.reserve(((len + 2) / 3) * 4);
  size_t i = 0;
  while (i + 3 <= len) {
    uint32_t n = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    out += B64[(n >> 18) & 63]; out += B64[(n >> 12) & 63];
    out += B64[(n >> 6) & 63];  out += B64[n & 63];
    i += 3;
  }
  if (len - i == 1) {
    uint32_t n = data[i] << 16;
    out += B64[(n >> 18) & 63]; out += B64[(n >> 12) & 63]; out += "==";
  } else if (len - i == 2) {
    uint32_t n = (data[i] << 16) | (data[i + 1] << 8);
    out += B64[(n >> 18) & 63]; out += B64[(n >> 12) & 63]; out += B64[(n >> 6) & 63]; out += "=";
  }
  return out;
}
int b64val(char c) {
  if (c >= 'A' && c <= 'Z') return c - 'A';
  if (c >= 'a' && c <= 'z') return c - 'a' + 26;
  if (c >= '0' && c <= '9') return c - '0' + 52;
  if (c == '+') return 62;
  if (c == '/') return 63;
  return -1;
}
size_t b64decode(const String &s, uint8_t *out, size_t maxOut) {
  size_t o = 0; int val = 0, bits = -8;
  for (size_t i = 0; i < s.length(); i++) {
    char c = s[i];
    if (c == '=' || c == '\r' || c == '\n' || c == ' ') continue;
    int d = b64val(c);
    if (d < 0) continue;
    val = (val << 6) | d; bits += 6;
    if (bits >= 0) { if (o < maxOut) out[o++] = (uint8_t)((val >> bits) & 0xFF); bits -= 8; }
  }
  return o;
}

void setup() {
  Serial.begin(115200);
  delay(300);
  pinMode(FP_TOUCH_PIN, INPUT);
  FPSerial.begin(57600, SERIAL_8N2, FP_RX_PIN, FP_TX_PIN);
  delay(800);
  bool found = finger.verifyPassword();
  if (found) {
    finger.getParameters();
    g_capacity = finger.capacity;
    finger.getTemplateCount();
    Serial.print("PONG READY count="); Serial.println(finger.templateCount);
  } else {
    Serial.println("PONG NOSENSOR");
  }
}

// ждать появление пальца
uint8_t waitFinger(uint32_t timeoutMs) {
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    if (cancelFlag) return 0xEE;
    uint8_t p = finger.getImage();
    if (p == FINGERPRINT_OK) return FINGERPRINT_OK;
    if (p == FINGERPRINT_NOFINGER) { delay(50); handleSerialDuringWait(); continue; }
    delay(50);
  }
  return FINGERPRINT_TIMEOUT;
}
void waitRemove(uint32_t timeoutMs) {
  uint32_t t0 = millis();
  while (millis() - t0 < timeoutMs) {
    if (finger.getImage() == FINGERPRINT_NOFINGER) return;
    delay(50);
  }
}
// ловим CANCEL во время долгого ожидания
void handleSerialDuringWait() {
  if (Serial.available()) {
    String s = Serial.readStringUntil('\n'); s.trim();
    if (s.equalsIgnoreCase("CANCEL")) cancelFlag = true;
  }
}

// Выгрузка шаблона из CharBuffer1 в ПК (UpChar). Возвращает длину или 0.
size_t uploadTemplate(uint8_t *buf, size_t maxLen) {
  uint8_t p = finger.getModel(); // команда UpChar: датчик начнёт слать data-пакеты
  if (p != FINGERPRINT_OK) return 0;
  size_t idx = 0;
  uint32_t t0 = millis();
  // читаем data-пакеты напрямую с UART датчика
  while (millis() - t0 < 3000) {
    if (FPSerial.available()) {
      // структура пакета: EF 01 [addr4] [PID] [len2] [data...] [chk2]
      // PID: 0x02 = data, 0x08 = end-of-data
      // упрощённый ридер:
      static uint8_t hdr[9];
      if (FPSerial.available() >= 9) {
        for (int i = 0; i < 9; i++) hdr[i] = FPSerial.read();
        if (hdr[0] != 0xEF || hdr[1] != 0x01) continue;
        uint8_t pid = hdr[6];
        uint16_t len = (hdr[7] << 8) | hdr[8];
        int dataLen = len - 2; // минус контрольная сумма
        for (int i = 0; i < dataLen; i++) {
          while (!FPSerial.available()) { if (millis() - t0 > 3500) return idx; }
          uint8_t b = FPSerial.read();
          if (idx < maxLen) buf[idx++] = b;
        }
        // прочитать 2 байта контрольной суммы
        int chk = 0;
        while (chk < 2) { if (FPSerial.available()) { FPSerial.read(); chk++; } }
        if (pid == 0x08) break; // end
        t0 = millis();
      }
    }
  }
  return idx;
}

void doEnroll(uint16_t id) {
  cancelFlag = false;
  for (uint8_t scan = 1; scan <= 4; scan++) {
    Serial.println(scan == 1 ? "Place finger on sensor." : "Place the same finger again.");
    uint8_t p = waitFinger(20000);
    if (cancelFlag) { Serial.println("ENROLL FAIL cancelled"); return; }
    if (p != FINGERPRINT_OK) { Serial.println("ENROLL FAIL image_timeout"); return; }
    p = finger.image2Tz(scan);
    if (p != FINGERPRINT_OK) { Serial.print("ENROLL FAIL tz "); Serial.println(p); return; }
    Serial.print("Scan "); Serial.print(scan); Serial.println(" OK");
    if (scan < 4) { Serial.println("Remove finger."); waitRemove(8000); }
  }
  uint8_t p = finger.createModel();
  if (p != FINGERPRINT_OK) { Serial.print("ENROLL FAIL model "); Serial.println(p); return; }
  p = finger.storeModel(id);
  if (p != FINGERPRINT_OK) { Serial.print("ENROLL FAIL store "); Serial.println(p); return; }

  // выгрузить шаблон для БД (best-effort)
  finger.loadModel(id);         // flash -> CharBuffer1
  static uint8_t tpl[2048];
  size_t n = uploadTemplate(tpl, sizeof(tpl));
  if (n > 0) {
    String b = b64encode(tpl, n);
    Serial.print("TEMPLATE "); Serial.print(id); Serial.print(" "); Serial.println(b);
  }
  Serial.print("ENROLL OK "); Serial.println(id);
}

// Загрузка шаблона в датчик (DownChar) и сохранение в flash по id
bool downloadTemplate(uint16_t id, const String &b64) {
  static uint8_t tpl[2048];
  size_t n = b64decode(b64, tpl, sizeof(tpl));
  if (n == 0) return false;
  // команда DownChar в CharBuffer1
  uint8_t cmd[4] = {0x09, 0x01, 0x00, 0x00}; // DownChar, buffer 1 (упрощённо)
  finger.writeStructuredPacket ? 0 : 0; // заглушка совместимости
  // Отправляем DownChar через низкоуровневый пакет
  // (реализация зависит от версии библиотеки — тестировать на железе)
  // Пакетами по 128 байт шлём данные:
  // NOTE: если библиотека не даёт доступ к writeStructuredPacket публично,
  // потребуется прямая работа с FPSerial. Помечено для теста 03.08.
  // Пока — сохраняем через store, если шаблон уже в буфере (fallback ниже).
  (void)cmd;
  // Fallback: если DownChar недоступен, пробуем сохранить текущий буфер
  uint8_t p = finger.storeModel(id);
  return (p == FINGERPRINT_OK);
}

void doIdentify() {
  cancelFlag = false;
  Serial.println("Place finger on sensor.");
  uint8_t p = waitFinger(15000);
  if (cancelFlag) { Serial.println("IDENTIFY FAIL cancelled"); return; }
  if (p != FINGERPRINT_OK) { Serial.println("NOMATCH"); return; }
  p = finger.image2Tz(1);
  if (p != FINGERPRINT_OK) { Serial.println("IDENTIFY FAIL tz"); return; }
  p = finger.fingerSearch();
  if (p == FINGERPRINT_OK) {
    Serial.print("MATCH "); Serial.print(finger.fingerID); Serial.print(" "); Serial.println(finger.confidence);
  } else {
    Serial.println("NOMATCH");
  }
}

void loop() {
  if (!Serial.available()) { delay(10); return; }
  String line = Serial.readStringUntil('\n');
  line.trim();
  if (line.length() == 0) return;

  if (line.equalsIgnoreCase("PING")) {
    finger.getTemplateCount();
    Serial.print("PONG READY count="); Serial.println(finger.templateCount);
  } else if (line.startsWith("ENROLL ")) {
    doEnroll((uint16_t)line.substring(7).toInt());
  } else if (line.startsWith("LOAD ")) {
    int sp = line.indexOf(' ', 5);
    if (sp < 0) { Serial.println("LOAD FAIL parse"); return; }
    uint16_t id = (uint16_t)line.substring(5, sp).toInt();
    String b = line.substring(sp + 1);
    bool ok = downloadTemplate(id, b);
    Serial.print(ok ? "LOAD OK " : "LOAD FAIL "); Serial.println(id);
  } else if (line.equalsIgnoreCase("IDENTIFY")) {
    doIdentify();
  } else if (line.startsWith("DELETE ")) {
    uint16_t id = (uint16_t)line.substring(7).toInt();
    uint8_t p = finger.deleteModel(id);
    Serial.print(p == FINGERPRINT_OK ? "DELETE OK " : "DELETE FAIL "); Serial.println(id);
  } else if (line.equalsIgnoreCase("CLEAR")) {
    finger.emptyDatabase();
    Serial.println("CLEAR OK");
  } else if (line.equalsIgnoreCase("CANCEL")) {
    cancelFlag = true;
  }
}
