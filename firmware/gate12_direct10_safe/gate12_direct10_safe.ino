/*
 * Gate12 control for two five-lane dispensers on one classic ESP32.
 *
 * Signal map:
 *   servo 0 -> D13 / GPIO13
 *   servo 1 -> D14 / GPIO14
 *   servo 2 -> D27 / GPIO27
 *   servo 3 -> D26 / GPIO26
 *   servo 4 -> D25 / GPIO25
 *   servos 5..9 -> not assigned; set pins only after wiring is confirmed.
 *
 * Servo power wiring:
 *   +5V    -> LM2596 OUT+
 *   GND    -> LM2596 OUT- and ESP32 GND
 *
 * The firmware intentionally has no auto movement on boot.
 *
 * Serial protocol, 115200:
 *   PING
 *   CH <servo>
 *   INFO
 *   INFO ALL
 *   SET <us>
 *   SET <servo> <us>
 *   STEP <delta_us>
 *   JOG <-1|0|1>
 *   JOG <servo> <-1|0|1>
 *   LIM <min_us> <max_us>
 *   LIM <servo> <min_us> <max_us>
 *   RATE <us_per_sec>
 *   RATE <servo> <us_per_sec>
 *   HOLD <0|1>
 *   HOLD <servo> <0|1>
 *   POWERMAX <ms>
 *   POWERMAX <servo> <ms>
 *   CYCLE <closed_us> <eject_us> <hold_ms>
 *   CYCLE <servo> <closed_us> <eject_us> <hold_ms>
 *   CYCLEID <servo> <closed_us> <eject_us> <hold_ms> <token>
 *   VERSION
 *   STOP
 *   STOP <servo>
 *   STOP ALL
 *   DETACH
 *   DETACH <servo>
 *   DETACH ALL
 */

#include <ESP32Servo.h>
#include <Preferences.h>
#include <esp_system.h>

const long BAUD = 115200;
const char* FW_VERSION = "2.1.0";

const uint8_t NUM_SERVOS = 10;
const int SERVO_PINS[NUM_SERVOS] = {
  13, 14, 27, 26, 25, -1, -1, -1, -1, -1
};

const int HARD_MIN_US = 700;
const int HARD_MAX_US = 2300;
const int CENTER_US = 1500;
const int DEFAULT_SAFE_MIN_US = 1450;
const int DEFAULT_SAFE_MAX_US = 1550;
// Equal values deliberately block a full cycle until direction is checked.
const int DEFAULT_CLOSED_US = 1500;
const int DEFAULT_EJECT_US = 1500;
const uint16_t AUTO_DETACH_MS = 250;
const unsigned long DEFAULT_POWER_MAX_MS = 3000;
const unsigned long POWER_MAX_LIMIT_MS = 600000UL;
const char* PREF_NAMESPACE = "gate12d5";

Servo gate[NUM_SERVOS];

bool servoAttached[NUM_SERVOS];
bool jogActive[NUM_SERVOS];
bool holdTorque[NUM_SERVOS];
bool cycleActive[NUM_SERVOS];
bool calibrationStored[NUM_SERVOS];

int currentUs[NUM_SERVOS];
int targetUs[NUM_SERVOS];
int safeMinUs[NUM_SERVOS];
int safeMaxUs[NUM_SERVOS];
int slewUsPerSec[NUM_SERVOS];
int8_t jogDir[NUM_SERVOS];

uint8_t cyclePhase[NUM_SERVOS];
int cycleClosedUs[NUM_SERVOS];
int cycleEjectUs[NUM_SERVOS];
unsigned long cycleHoldUntil[NUM_SERVOS];
unsigned long cycleHoldMs[NUM_SERVOS];
uint32_t cycleToken[NUM_SERVOS];

unsigned long lastMotionUs[NUM_SERVOS];
uint32_t motionRemainder[NUM_SERVOS];
unsigned long detachAtMs[NUM_SERVOS];
unsigned long attachedAtMs[NUM_SERVOS];
unsigned long powerMaxMs[NUM_SERVOS];

uint8_t activeServo = 0;
String buf;
esp_reset_reason_t bootResetReason = ESP_RST_UNKNOWN;

void forceSignalLow(uint8_t servo) {
  if (servo >= NUM_SERVOS || SERVO_PINS[servo] < 0) return;
  pinMode(SERVO_PINS[servo], OUTPUT);
  digitalWrite(SERVO_PINS[servo], LOW);
}

void prefKey(char* target, size_t length, char prefix, uint8_t servo) {
  snprintf(target, length, "%c%u", prefix, servo);
}

void loadCalibration(uint8_t servo) {
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, true)) {
    return;
  }

  char key[8];
  prefKey(key, sizeof(key), 'v', servo);
  bool valid = prefs.getBool(key, false);
  if (valid) {
    prefKey(key, sizeof(key), 'h', servo);
    int homeUs = prefs.getInt(key, DEFAULT_CLOSED_US);
    prefKey(key, sizeof(key), 'e', servo);
    int ejectUs = prefs.getInt(key, DEFAULT_EJECT_US);
    if (homeUs >= HARD_MIN_US && homeUs <= HARD_MAX_US &&
        ejectUs >= HARD_MIN_US && ejectUs <= HARD_MAX_US &&
        abs(homeUs - ejectUs) >= 20) {
      cycleClosedUs[servo] = homeUs;
      cycleEjectUs[servo] = ejectUs;
      safeMinUs[servo] = max(HARD_MIN_US, min(homeUs, ejectUs) - 60);
      safeMaxUs[servo] = min(HARD_MAX_US, max(homeUs, ejectUs) + 60);
      // No pulse is generated here. This only makes the first later command start
      // from the HOME value that was saved during calibration.
      currentUs[servo] = homeUs;
      targetUs[servo] = homeUs;
      calibrationStored[servo] = true;
    }
  }
  prefs.end();
}

bool saveCalibration(uint8_t servo, int homeUs, int ejectUs) {
  if (!validServo(servo) || homeUs < HARD_MIN_US || homeUs > HARD_MAX_US ||
      ejectUs < HARD_MIN_US || ejectUs > HARD_MAX_US || abs(homeUs - ejectUs) < 20) {
    return false;
  }

  // CAL is also used by the PC to synchronise values after reconnecting. Do not
  // rewrite identical data to NVS on every dispense cycle: that adds latency and
  // needless flash commits without changing the calibration.
  bool changed = !calibrationStored[servo] ||
                 cycleClosedUs[servo] != homeUs ||
                 cycleEjectUs[servo] != ejectUs;
  if (changed) {
    Preferences prefs;
    if (!prefs.begin(PREF_NAMESPACE, false)) {
      return false;
    }
    char key[8];
    prefKey(key, sizeof(key), 'h', servo);
    size_t homeWritten = prefs.putInt(key, homeUs);
    prefKey(key, sizeof(key), 'e', servo);
    size_t ejectWritten = prefs.putInt(key, ejectUs);
    prefKey(key, sizeof(key), 'v', servo);
    size_t validWritten = prefs.putBool(key, true);
    prefs.end();
    if (homeWritten != sizeof(int32_t) || ejectWritten != sizeof(int32_t) ||
        validWritten != sizeof(bool)) {
      return false;
    }
  }

  cycleClosedUs[servo] = homeUs;
  cycleEjectUs[servo] = ejectUs;
  safeMinUs[servo] = max(HARD_MIN_US, min(homeUs, ejectUs) - 60);
  safeMaxUs[servo] = min(HARD_MAX_US, max(homeUs, ejectUs) + 60);
  calibrationStored[servo] = true;
  if (!servoAttached[servo]) {
    currentUs[servo] = homeUs;
    targetUs[servo] = homeUs;
  }
  return true;
}

bool clearCalibration(uint8_t servo) {
  if (!validServo(servo)) {
    return false;
  }
  Preferences prefs;
  if (!prefs.begin(PREF_NAMESPACE, false)) {
    return false;
  }
  char key[8];
  prefKey(key, sizeof(key), 'h', servo);
  prefs.remove(key);
  prefKey(key, sizeof(key), 'e', servo);
  prefs.remove(key);
  prefKey(key, sizeof(key), 'v', servo);
  prefs.remove(key);
  prefs.end();

  calibrationStored[servo] = false;
  cycleClosedUs[servo] = DEFAULT_CLOSED_US;
  cycleEjectUs[servo] = DEFAULT_EJECT_US;
  safeMinUs[servo] = DEFAULT_SAFE_MIN_US;
  safeMaxUs[servo] = DEFAULT_SAFE_MAX_US;
  if (!servoAttached[servo]) {
    currentUs[servo] = CENTER_US;
    targetUs[servo] = CENTER_US;
  }
  return true;
}

bool validServo(int servo) {
  return servo >= 0 && servo < NUM_SERVOS && SERVO_PINS[servo] >= 0;
}

uint16_t configuredMask() {
  uint16_t mask = 0;
  for (uint8_t servo = 0; servo < NUM_SERVOS; servo++) {
    if (validServo(servo)) mask |= (1U << servo);
  }
  return mask;
}

int clampHard(int us) {
  return constrain(us, HARD_MIN_US, HARD_MAX_US);
}

int clampSafe(uint8_t servo, int us) {
  return constrain(us, safeMinUs[servo], safeMaxUs[servo]);
}

unsigned long clampPowerMax(int ms) {
  if (ms <= 0) {
    return 0;
  }
  if ((unsigned long)ms > POWER_MAX_LIMIT_MS) {
    return POWER_MAX_LIMIT_MS;
  }
  return (unsigned long)ms;
}

bool movingNow(uint8_t servo) {
  return jogActive[servo] || currentUs[servo] != targetUs[servo] || cycleActive[servo];
}

int firstMovingServo() {
  for (uint8_t servo = 0; servo < NUM_SERVOS; servo++) {
    if (movingNow(servo)) {
      return (int)servo;
    }
  }
  return -1;
}

int firstCycleServo() {
  for (uint8_t servo = 0; servo < NUM_SERVOS; servo++) {
    if (cycleActive[servo]) {
      return (int)servo;
    }
  }
  return -1;
}

bool rejectDuringProductionCycle(const char* operation) {
  int busyServo = firstCycleServo();
  if (busyServo < 0) {
    return false;
  }
  Serial.printf("ERR production_busy operation=%s active=%d\n", operation, busyServo);
  return true;
}

void cancelDetach(uint8_t servo) {
  detachAtMs[servo] = 0;
}

void detachServo(uint8_t servo) {
  if (servoAttached[servo]) {
    gate[servo].detach();
    // Do not leave the servo signal wire floating: a floating input can interpret
    // electrical noise as short commands and twitch unexpectedly.
    forceSignalLow(servo);
    servoAttached[servo] = false;
  }
  detachAtMs[servo] = 0;
  attachedAtMs[servo] = 0;
}

void scheduleDetach(uint8_t servo) {
  if (!holdTorque[servo] && servoAttached[servo] && !movingNow(servo)) {
    detachAtMs[servo] = millis() + AUTO_DETACH_MS;
  }
}

void attachAt(uint8_t servo, int us) {
  if (!validServo(servo)) {
    Serial.println("ERR pin_not_configured");
    return;
  }
  if (!servoAttached[servo]) {
    gate[servo].attach(SERVO_PINS[servo], HARD_MIN_US, HARD_MAX_US);
    servoAttached[servo] = true;
    attachedAtMs[servo] = millis();
  }
  currentUs[servo] = clampSafe(servo, us);
  targetUs[servo] = currentUs[servo];
  gate[servo].writeMicroseconds(currentUs[servo]);
  lastMotionUs[servo] = micros();
  motionRemainder[servo] = 0;
  cancelDetach(servo);
}

void beginMoveTo(uint8_t servo, int us) {
  int next = clampSafe(servo, us);
  if (!servoAttached[servo]) {
    attachAt(servo, currentUs[servo]);
  }
  jogActive[servo] = false;
  jogDir[servo] = 0;
  targetUs[servo] = next;
  lastMotionUs[servo] = micros();
  motionRemainder[servo] = 0;
  cancelDetach(servo);
}

void stopMotion(uint8_t servo) {
  updateMotion(servo);
  cycleActive[servo] = false;
  cyclePhase[servo] = 0;
  cycleToken[servo] = 0;
  jogActive[servo] = false;
  jogDir[servo] = 0;
  targetUs[servo] = currentUs[servo];
  if (servoAttached[servo]) {
    gate[servo].writeMicroseconds(currentUs[servo]);
  }
  scheduleDetach(servo);
}

void beginJog(uint8_t servo, int dir) {
  dir = (dir > 0) ? 1 : (dir < 0 ? -1 : 0);
  if (dir == 0) {
    stopMotion(servo);
    return;
  }
  if (!servoAttached[servo]) {
    attachAt(servo, currentUs[servo]);
  }
  cycleActive[servo] = false;
  cyclePhase[servo] = 0;
  jogActive[servo] = true;
  jogDir[servo] = (int8_t)dir;
  targetUs[servo] = currentUs[servo];
  lastMotionUs[servo] = micros();
  motionRemainder[servo] = 0;
  cancelDetach(servo);
}

void updateAutoDetach(uint8_t servo) {
  if (detachAtMs[servo] == 0 || holdTorque[servo] || movingNow(servo)) {
    return;
  }
  if ((long)(millis() - detachAtMs[servo]) >= 0) {
    detachServo(servo);
  }
}

void updatePowerWatchdog(uint8_t servo) {
  if (!servoAttached[servo] || powerMaxMs[servo] == 0 || attachedAtMs[servo] == 0) {
    return;
  }
  if (millis() - attachedAtMs[servo] >= powerMaxMs[servo]) {
    cycleActive[servo] = false;
    cyclePhase[servo] = 0;
    cycleToken[servo] = 0;
    jogActive[servo] = false;
    jogDir[servo] = 0;
    targetUs[servo] = currentUs[servo];
    detachServo(servo);
    Serial.printf("SAFE DETACH %u power_timeout\n", servo);
  }
}

void updateMotion(uint8_t servo) {
  if (!servoAttached[servo] || !movingNow(servo)) {
    lastMotionUs[servo] = micros();
    motionRemainder[servo] = 0;
    return;
  }

  unsigned long now = micros();
  unsigned long dt = now - lastMotionUs[servo];
  if (dt < 1000) {
    return;
  }
  lastMotionUs[servo] = now;

  uint64_t movement = (uint64_t)slewUsPerSec[servo] * (uint64_t)dt + motionRemainder[servo];
  int maxStep = (int)(movement / 1000000ULL);
  motionRemainder[servo] = (uint32_t)(movement % 1000000ULL);
  if (maxStep < 1) {
    return;
  }

  if (jogActive[servo]) {
    int next = currentUs[servo] + (jogDir[servo] > 0 ? maxStep : -maxStep);
    currentUs[servo] = clampSafe(servo, next);
    targetUs[servo] = currentUs[servo];
    if ((jogDir[servo] < 0 && currentUs[servo] <= safeMinUs[servo]) ||
        (jogDir[servo] > 0 && currentUs[servo] >= safeMaxUs[servo])) {
      jogActive[servo] = false;
      jogDir[servo] = 0;
      scheduleDetach(servo);
    }
  } else {
    int delta = targetUs[servo] - currentUs[servo];
    bool reached = false;
    if (abs(delta) <= maxStep) {
      currentUs[servo] = targetUs[servo];
      reached = true;
    } else {
      currentUs[servo] += (delta > 0) ? maxStep : -maxStep;
    }
    if (reached) {
      scheduleDetach(servo);
    }
  }

  gate[servo].writeMicroseconds(currentUs[servo]);
}

void beginCycle(uint8_t servo, int closedUs, int ejectUs, unsigned long holdMs, uint32_t token) {
  cycleClosedUs[servo] = closedUs;
  cycleEjectUs[servo] = ejectUs;
  cycleHoldMs[servo] = holdMs;
  cycleToken[servo] = token;

  if (!servoAttached[servo]) {
    attachAt(servo, currentUs[servo]);
  }

  cycleActive[servo] = true;
  cyclePhase[servo] = 1;
  beginMoveTo(servo, cycleClosedUs[servo]);
}

bool validateAndBeginCycle(uint8_t servo, int closedUs, int ejectUs, int holdMs, uint32_t token = 0) {
  if (!calibrationStored[servo]) {
    Serial.printf("ERR not_calibrated servo=%u\n", servo);
    return false;
  }
  if (closedUs < HARD_MIN_US || closedUs > HARD_MAX_US ||
      ejectUs < HARD_MIN_US || ejectUs > HARD_MAX_US ||
      abs(closedUs - ejectUs) < 20 || holdMs < 50 || holdMs > 5000) {
    Serial.printf("ERR bad_cycle servo=%u\n", servo);
    return false;
  }
  if (closedUs < safeMinUs[servo] || closedUs > safeMaxUs[servo] ||
      ejectUs < safeMinUs[servo] || ejectUs > safeMaxUs[servo]) {
    Serial.printf(
      "ERR cycle_limits servo=%u home=%d eject=%d min=%d max=%d\n",
      servo, closedUs, ejectUs, safeMinUs[servo], safeMaxUs[servo]
    );
    return false;
  }

  // A PC bug or a second client must never create the same inrush-current peak
  // that previously made channels miss or stop short. Calibration JOG remains
  // independently available, but production CYCLE commands are interlocked.
  int busyServo = firstMovingServo();
  if (busyServo >= 0) {
    Serial.printf("ERR busy requested=%u active=%d\n", servo, busyServo);
    return false;
  }

  beginCycle(servo, closedUs, ejectUs, (unsigned long)holdMs, token);
  return true;
}

void updateCycle(uint8_t servo) {
  if (!cycleActive[servo]) {
    return;
  }

  if (cyclePhase[servo] == 1 && currentUs[servo] == targetUs[servo]) {
    beginMoveTo(servo, cycleEjectUs[servo]);
    cyclePhase[servo] = 2;
    return;
  }

  if (cyclePhase[servo] == 2 && currentUs[servo] == targetUs[servo]) {
    cycleHoldUntil[servo] = millis() + cycleHoldMs[servo];
    cyclePhase[servo] = 3;
    return;
  }

  if (cyclePhase[servo] == 3 && (long)(millis() - cycleHoldUntil[servo]) >= 0) {
    beginMoveTo(servo, cycleClosedUs[servo]);
    cyclePhase[servo] = 4;
    return;
  }

  if (cyclePhase[servo] == 4 && currentUs[servo] == targetUs[servo]) {
    uint32_t completedToken = cycleToken[servo];
    cycleActive[servo] = false;
    cyclePhase[servo] = 0;
    cycleToken[servo] = 0;
    scheduleDetach(servo);
    if (completedToken != 0) {
      Serial.printf("DONE %u token=%lu\n", servo, (unsigned long)completedToken);
    } else {
      Serial.printf("DONE %u\n", servo);
    }
  }
}

void printInfo(uint8_t servo) {
  unsigned long poweredMs = (servoAttached[servo] && attachedAtMs[servo] != 0) ? millis() - attachedAtMs[servo] : 0;
  Serial.printf(
    "INFO servo=%u pin=%d attached=%d pos=%d target=%d min=%d max=%d home=%d eject=%d cal=%d rate=%d jog=%d hold=%d cycle=%d token=%lu pmax=%lu power=%lu\n",
    servo,
    SERVO_PINS[servo],
    servoAttached[servo] ? 1 : 0,
    currentUs[servo],
    targetUs[servo],
    safeMinUs[servo],
    safeMaxUs[servo],
    cycleClosedUs[servo],
    cycleEjectUs[servo],
    calibrationStored[servo] ? 1 : 0,
    slewUsPerSec[servo],
    jogDir[servo],
    holdTorque[servo] ? 1 : 0,
    cycleActive[servo] ? 1 : 0,
    (unsigned long)cycleToken[servo],
    powerMaxMs[servo],
    poweredMs
  );
}

bool parseOneInt(const String& line, const char* fmt, int& a) {
  return sscanf(line.c_str(), fmt, &a) == 1;
}

bool parseTwoInts(const String& line, const char* fmt, int& a, int& b) {
  return sscanf(line.c_str(), fmt, &a, &b) == 2;
}

bool parseThreeInts(const String& line, const char* fmt, int& a, int& b, int& c) {
  return sscanf(line.c_str(), fmt, &a, &b, &c) == 3;
}

bool parseFourInts(const String& line, const char* fmt, int& a, int& b, int& c, int& d) {
  return sscanf(line.c_str(), fmt, &a, &b, &c, &d) == 4;
}

void printErrServo() {
  Serial.println("ERR servo");
}

void handle(String line) {
  line.trim();
  if (line.length() == 0) {
    return;
  }

  String cmd = line;
  cmd.toUpperCase();

  if (cmd == "PING") {
    Serial.println("PONG");
    return;
  }

  if (cmd == "VERSION") {
    Serial.printf(
      "VERSION gate12_direct10_safe fw=%s cycle_id=1 interlock=1 channels=%u configured_mask=%u reset_reason=%d uptime_ms=%lu\n",
      FW_VERSION, NUM_SERVOS, configuredMask(), (int)bootResetReason, millis()
    );
    return;
  }

  if (cmd == "INFO") {
    printInfo(activeServo);
    return;
  }

  if (cmd == "INFO ALL") {
    for (uint8_t i = 0; i < NUM_SERVOS; i++) {
      printInfo(i);
    }
    return;
  }

  int a = 0;
  int b = 0;
  int c = 0;
  int d = 0;

  if (parseOneInt(cmd, "CH %d", a)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    activeServo = (uint8_t)a;
    Serial.printf("OK CH %u\n", activeServo);
    return;
  }

  if (cmd == "STOP") {
    stopMotion(activeServo);
    Serial.printf("OK STOP %u %d\n", activeServo, currentUs[activeServo]);
    return;
  }

  if (cmd == "STOP ALL") {
    for (uint8_t servo = 0; servo < NUM_SERVOS; servo++) {
      stopMotion(servo);
    }
    Serial.println("OK STOP ALL");
    return;
  }

  if (parseOneInt(cmd, "STOP %d", a)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    stopMotion((uint8_t)a);
    Serial.printf("OK STOP %d %d\n", a, currentUs[a]);
    return;
  }

  if (cmd == "DETACH") {
    stopMotion(activeServo);
    detachServo(activeServo);
    Serial.printf("OK DETACH %u\n", activeServo);
    return;
  }

  if (cmd == "DETACH ALL") {
    for (uint8_t servo = 0; servo < NUM_SERVOS; servo++) {
      stopMotion(servo);
      detachServo(servo);
    }
    Serial.println("OK DETACH ALL");
    return;
  }

  if (parseOneInt(cmd, "DETACH %d", a)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    stopMotion((uint8_t)a);
    detachServo((uint8_t)a);
    Serial.printf("OK DETACH %d\n", a);
    return;
  }

  if (parseTwoInts(cmd, "SET %d %d", a, b)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (rejectDuringProductionCycle("SET")) {
      return;
    }
    beginMoveTo((uint8_t)a, b);
    Serial.printf("OK SET %d %d\n", a, targetUs[a]);
    return;
  }

  if (parseOneInt(cmd, "SET %d", a)) {
    if (rejectDuringProductionCycle("SET")) {
      return;
    }
    beginMoveTo(activeServo, a);
    Serial.printf("OK SET %u %d\n", activeServo, targetUs[activeServo]);
    return;
  }

  if (parseTwoInts(cmd, "STEP %d %d", a, b)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (rejectDuringProductionCycle("STEP")) {
      return;
    }
    beginMoveTo((uint8_t)a, targetUs[a] + b);
    Serial.printf("OK SET %d %d\n", a, targetUs[a]);
    return;
  }

  if (parseOneInt(cmd, "STEP %d", a)) {
    if (rejectDuringProductionCycle("STEP")) {
      return;
    }
    beginMoveTo(activeServo, targetUs[activeServo] + a);
    Serial.printf("OK SET %u %d\n", activeServo, targetUs[activeServo]);
    return;
  }

  if (parseTwoInts(cmd, "JOG %d %d", a, b)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (rejectDuringProductionCycle("JOG")) {
      return;
    }
    beginJog((uint8_t)a, b);
    Serial.printf("OK JOG %d %d %d\n", a, jogDir[a], currentUs[a]);
    return;
  }

  if (parseOneInt(cmd, "JOG %d", a)) {
    if (rejectDuringProductionCycle("JOG")) {
      return;
    }
    beginJog(activeServo, a);
    Serial.printf("OK JOG %u %d %d\n", activeServo, jogDir[activeServo], currentUs[activeServo]);
    return;
  }

  if (parseThreeInts(cmd, "LIM %d %d %d", a, b, c)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (rejectDuringProductionCycle("LIM")) {
      return;
    }
    b = clampHard(b);
    c = clampHard(c);
    if (b >= c || c - b < 20) {
      Serial.println("ERR bad_limits");
      return;
    }
    safeMinUs[a] = b;
    safeMaxUs[a] = c;
    currentUs[a] = clampSafe((uint8_t)a, currentUs[a]);
    targetUs[a] = clampSafe((uint8_t)a, targetUs[a]);
    if (servoAttached[a]) {
      gate[a].writeMicroseconds(currentUs[a]);
    }
    Serial.printf("OK LIM %d %d %d\n", a, safeMinUs[a], safeMaxUs[a]);
    return;
  }

  if (parseTwoInts(cmd, "LIM %d %d", a, b)) {
    if (rejectDuringProductionCycle("LIM")) {
      return;
    }
    a = clampHard(a);
    b = clampHard(b);
    if (a >= b || b - a < 20) {
      Serial.println("ERR bad_limits");
      return;
    }
    safeMinUs[activeServo] = a;
    safeMaxUs[activeServo] = b;
    currentUs[activeServo] = clampSafe(activeServo, currentUs[activeServo]);
    targetUs[activeServo] = clampSafe(activeServo, targetUs[activeServo]);
    if (servoAttached[activeServo]) {
      gate[activeServo].writeMicroseconds(currentUs[activeServo]);
    }
    Serial.printf("OK LIM %u %d %d\n", activeServo, safeMinUs[activeServo], safeMaxUs[activeServo]);
    return;
  }

  if (parseTwoInts(cmd, "RATE %d %d", a, b)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (rejectDuringProductionCycle("RATE")) {
      return;
    }
    slewUsPerSec[a] = constrain(b, 5, 2000);
    Serial.printf("OK RATE %d %d\n", a, slewUsPerSec[a]);
    return;
  }

  if (parseOneInt(cmd, "RATE %d", a)) {
    if (rejectDuringProductionCycle("RATE")) {
      return;
    }
    slewUsPerSec[activeServo] = constrain(a, 5, 2000);
    Serial.printf("OK RATE %u %d\n", activeServo, slewUsPerSec[activeServo]);
    return;
  }

  if (parseTwoInts(cmd, "HOLD %d %d", a, b)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (rejectDuringProductionCycle("HOLD")) {
      return;
    }
    holdTorque[a] = b != 0;
    if (holdTorque[a]) {
      cancelDetach((uint8_t)a);
    } else {
      scheduleDetach((uint8_t)a);
    }
    Serial.printf("OK HOLD %d %d\n", a, holdTorque[a] ? 1 : 0);
    return;
  }

  if (parseOneInt(cmd, "HOLD %d", a)) {
    if (rejectDuringProductionCycle("HOLD")) {
      return;
    }
    holdTorque[activeServo] = a != 0;
    if (holdTorque[activeServo]) {
      cancelDetach(activeServo);
    } else {
      scheduleDetach(activeServo);
    }
    Serial.printf("OK HOLD %u %d\n", activeServo, holdTorque[activeServo] ? 1 : 0);
    return;
  }

  if (parseTwoInts(cmd, "POWERMAX %d %d", a, b)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (rejectDuringProductionCycle("POWERMAX")) {
      return;
    }
    powerMaxMs[a] = clampPowerMax(b);
    Serial.printf("OK POWERMAX %d %lu\n", a, powerMaxMs[a]);
    return;
  }

  if (parseOneInt(cmd, "POWERMAX %d", a)) {
    if (rejectDuringProductionCycle("POWERMAX")) {
      return;
    }
    powerMaxMs[activeServo] = clampPowerMax(a);
    Serial.printf("OK POWERMAX %u %lu\n", activeServo, powerMaxMs[activeServo]);
    return;
  }

  if (parseThreeInts(cmd, "CAL %d %d %d", a, b, c)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (rejectDuringProductionCycle("CAL")) {
      return;
    }
    if (movingNow((uint8_t)a)) {
      Serial.printf("ERR busy_calibration servo=%d\n", a);
      return;
    }
    if (!saveCalibration((uint8_t)a, b, c)) {
      Serial.println("ERR bad_calibration");
      return;
    }
    Serial.printf("OK CAL %d %d %d SAVED\n", a, cycleClosedUs[a], cycleEjectUs[a]);
    return;
  }

  if (parseOneInt(cmd, "CLEARCAL %d", a)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (rejectDuringProductionCycle("CLEARCAL")) {
      return;
    }
    stopMotion((uint8_t)a);
    detachServo((uint8_t)a);
    if (!clearCalibration((uint8_t)a)) {
      Serial.println("ERR clear_calibration");
      return;
    }
    Serial.printf("OK CLEARCAL %d CENTER=%d\n", a, CENTER_US);
    return;
  }

  if (parseFourInts(cmd, "CYCLE %d %d %d %d", a, b, c, d)) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (!validateAndBeginCycle((uint8_t)a, b, c, d)) {
      return;
    }
    Serial.printf("OK CYCLE %d %d %d %d\n", a, cycleClosedUs[a], cycleEjectUs[a], (int)cycleHoldMs[a]);
    return;
  }

  int tokenValue = 0;
  if (sscanf(cmd.c_str(), "CYCLEID %d %d %d %d %d", &a, &b, &c, &d, &tokenValue) == 5) {
    if (!validServo(a)) {
      printErrServo();
      return;
    }
    if (tokenValue <= 0) {
      Serial.println("ERR bad_token");
      return;
    }
    if (!validateAndBeginCycle((uint8_t)a, b, c, d, (uint32_t)tokenValue)) {
      return;
    }
    Serial.printf(
      "OK CYCLEID %d %d %d %d token=%lu\n",
      a, cycleClosedUs[a], cycleEjectUs[a], (int)cycleHoldMs[a],
      (unsigned long)cycleToken[a]
    );
    return;
  }

  if (parseThreeInts(cmd, "CYCLE %d %d %d", a, b, c)) {
    if (!validateAndBeginCycle(activeServo, a, b, c)) {
      return;
    }
    Serial.printf("OK CYCLE %u %d %d %d\n", activeServo, cycleClosedUs[activeServo], cycleEjectUs[activeServo], (int)cycleHoldMs[activeServo]);
    return;
  }

  Serial.println("ERR unknown");
}

void setup() {
  bootResetReason = esp_reset_reason();
  Serial.begin(BAUD);

  // Match the official ESP32Servo multi-servo setup: reserve every LEDC timer
  // up front and explicitly use the standard 50 Hz servo refresh frequency.
  // Channels stay serialized across both dispensers.
  ESP32PWM::allocateTimer(0);
  ESP32PWM::allocateTimer(1);
  ESP32PWM::allocateTimer(2);
  ESP32PWM::allocateTimer(3);
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    gate[i].setPeriodHertz(50);
  }

  // Establish a defined LOW level before the serial startup delay. This produces
  // no valid servo pulse and prevents unconnected/floating signal inputs.
  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    forceSignalLow(i);
  }
  delay(300);

  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    servoAttached[i] = false;
    jogActive[i] = false;
    holdTorque[i] = false;
    cycleActive[i] = false;
    calibrationStored[i] = false;
    currentUs[i] = CENTER_US;
    targetUs[i] = CENTER_US;
    safeMinUs[i] = DEFAULT_SAFE_MIN_US;
    safeMaxUs[i] = DEFAULT_SAFE_MAX_US;
    slewUsPerSec[i] = 300;
    jogDir[i] = 0;
    cyclePhase[i] = 0;
    cycleClosedUs[i] = DEFAULT_CLOSED_US;
    cycleEjectUs[i] = DEFAULT_EJECT_US;
    cycleHoldUntil[i] = 0;
    cycleHoldMs[i] = 900;
    cycleToken[i] = 0;
    lastMotionUs[i] = micros();
    motionRemainder[i] = 0;
    detachAtMs[i] = 0;
    attachedAtMs[i] = 0;
    powerMaxMs[i] = DEFAULT_POWER_MAX_MS;
    loadCalibration(i);
  }

  Serial.printf(
    "READY gate12_direct10_safe fw=%s servos=%u no_auto_move interlock=1 cycle_id=1 reset_reason=%d\n",
    FW_VERSION, NUM_SERVOS, (int)bootResetReason
  );
  printInfo(activeServo);
}

void loop() {
  while (Serial.available()) {
    char ch = (char)Serial.read();
    if (ch == '\n') {
      handle(buf);
      buf = "";
    } else if (ch != '\r') {
      buf += ch;
      if (buf.length() > 120) {
        buf = "";
        Serial.println("ERR line_too_long");
      }
    }
  }

  for (uint8_t i = 0; i < NUM_SERVOS; i++) {
    updateMotion(i);
    updateCycle(i);
    updatePowerWatchdog(i);
    updateAutoDetach(i);
  }
}
