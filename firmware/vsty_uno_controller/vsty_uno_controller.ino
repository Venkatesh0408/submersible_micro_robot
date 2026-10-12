/*
 * VSTY — Submersible Micro Robot (Project Aqua)
 * Master Controller Firmware for Arduino UNO R3 (ATmega328P)
 * Protocol: VSTY/1 (115200 baud, newline-delimited ASCII)
 *
 * SAFETY & HARDWARE NOTES:
 * 1. Memory-safe for Arduino UNO R3 (2 KB SRAM): uses fixed-size char buffers,
 *    zero dynamic String heap allocations, and no third-party libraries.
 * 2. MPU-6500 IMU at I2C 0x68: verifies WHO_AM_I (0x75) == 0x70 using direct
 *    register reads and hardware I2C wire timeout protection.
 * 3. Turbidity sensor on A0: reports raw 10-bit ADC (0..1023) without fabricated NTU constants.
 * 4. Incremental Stage-1 Bench Actuation (1x R385 Motor on L298N Channel 1 + 1x MG90S Servo):
 *    - Servo.h on UNO R3 uses Timer1 (disabling PWM on D9/D10).
 *    - Therefore L298N ENA uses D5 (Timer0 PWM) and MG90S Servo signal uses D9.
 *    - Initial state on boot/reset is DISARMED with Motor PWM = 0 and Servo = 90 deg (neutral).
 *    - Communication watchdog (2000 ms) and per-command duration timer automatically
 *      cut propulsion if host communication is lost or stale.
 */

#include <Arduino.h>
#include <Wire.h>
#include <Servo.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

// ---------------- PIN CONFIGURATION (CONFIRM BEFORE ENERGISING) ----------------
static const uint8_t PIN_TURBIDITY = A0;  // Analog turbidity sensor signal
static const uint8_t PIN_M1_ENA    = 5;   // L298N ENA (Timer0 PWM pin D5)
static const uint8_t PIN_M1_IN1    = 7;   // L298N IN1 (Direction A)
static const uint8_t PIN_M1_IN2    = 8;   // L298N IN2 (Direction B)
static const uint8_t PIN_SERVO1    = 9;   // MG90S Servo 1 signal (powered by external 5V UBEC!)

// ---------------- IMU (MPU-6500 @ 0x68) CONSTANTS ----------------
static const uint8_t IMU_I2C_ADDR     = 0x68;
static const uint8_t REG_PWR_MGMT_1   = 0x6B;
static const uint8_t REG_ACCEL_XOUT_H = 0x3B;
static const uint8_t REG_WHO_AM_I     = 0x75;
static const uint8_t EXPECTED_WHO_AM_I = 0x70; // Verified MPU-6500 WHO_AM_I value

// ---------------- SAFETY BOUNDS & TIMERS ----------------
static const unsigned long WATCHDOG_TIMEOUT_MS = 2000UL;
static const unsigned long TELEM_INTERVAL_MS   = 250UL;
static const int16_t MAX_SAFE_PWM              = 180;
static const int16_t SERVO_MIN_DEG             = 45;
static const int16_t SERVO_MAX_DEG             = 135;
static const int16_t SERVO_NEUTRAL_DEG         = 90;

// ---------------- RUNTIME STATE ----------------
static Servo servo1;
static bool isArmed = false;
static bool isEstop = false;
static int16_t currentMotor1Pwm = 0;
static int16_t currentServo1Deg = SERVO_NEUTRAL_DEG;
static unsigned long lastHostCommMs = 0;
static unsigned long motor1StopAtMs = 0;
static unsigned long lastTelemSentMs = 0;

// IMU state
static bool imuOk = false;
static uint8_t imuWhoAmI = 0x00;
static int16_t axRaw = 0, ayRaw = 0, azRaw = 0;
static int16_t gxRaw = 0, gyRaw = 0, gzRaw = 0;
static int16_t rollDeciDeg = 0;
static int16_t pitchDeciDeg = 0;

// Bounded serial line buffer
static const uint8_t RX_BUF_SIZE = 128;
static char rxBuf[RX_BUF_SIZE];
static uint8_t rxLen = 0;
static bool rxOverflow = false;

// ---------------- ACTUATOR SAFETY FUNCTIONS ----------------
static void applyMotor1SafeZero() {
  digitalWrite(PIN_M1_IN1, LOW);
  digitalWrite(PIN_M1_IN2, LOW);
  analogWrite(PIN_M1_ENA, 0);
  currentMotor1Pwm = 0;
  motor1StopAtMs = 0;
}

static void applyMotor1Pwm(int16_t pwm) {
  if (!isArmed || isEstop || pwm == 0) {
    applyMotor1SafeZero();
    return;
  }
  int16_t clamped = pwm;
  if (clamped > MAX_SAFE_PWM) clamped = MAX_SAFE_PWM;
  if (clamped < -MAX_SAFE_PWM) clamped = -MAX_SAFE_PWM;

  if (clamped > 0) {
    digitalWrite(PIN_M1_IN1, HIGH);
    digitalWrite(PIN_M1_IN2, LOW);
    analogWrite(PIN_M1_ENA, (uint8_t)clamped);
  } else {
    digitalWrite(PIN_M1_IN1, LOW);
    digitalWrite(PIN_M1_IN2, HIGH);
    analogWrite(PIN_M1_ENA, (uint8_t)(-clamped));
  }
  currentMotor1Pwm = clamped;
}

static void applyServo1Deg(int16_t deg) {
  int16_t clamped = deg;
  if (clamped < SERVO_MIN_DEG) clamped = SERVO_MIN_DEG;
  if (clamped > SERVO_MAX_DEG) clamped = SERVO_MAX_DEG;
  servo1.write(clamped);
  currentServo1Deg = clamped;
}

static void disarmAndStopAll() {
  isArmed = false;
  applyMotor1SafeZero();
  applyServo1Deg(SERVO_NEUTRAL_DEG);
}

// ---------------- MPU-6500 I2C FUNCTIONS ----------------
static uint8_t readImuRegister(uint8_t reg, bool *okOut) {
  Wire.beginTransmission(IMU_I2C_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission(false) != 0) {
    *okOut = false;
    return 0x00;
  }
  if (Wire.requestFrom(IMU_I2C_ADDR, (uint8_t)1, (uint8_t)true) != 1) {
    *okOut = false;
    return 0x00;
  }
  *okOut = true;
  return Wire.read();
}

static void initImu() {
  Wire.begin();
#if defined(WIRE_HAS_TIMEOUT)
  Wire.setWireTimeout(3000, true); // 3ms timeout prevents I2C bus hang from freezing loop
#endif
  Wire.beginTransmission(IMU_I2C_ADDR);
  Wire.write(REG_PWR_MGMT_1);
  Wire.write(0x00); // Wake up MPU-6500
  if (Wire.endTransmission(true) != 0) {
    imuOk = false;
    imuWhoAmI = 0x00;
    return;
  }
  delay(10);
  bool readOk = false;
  imuWhoAmI = readImuRegister(REG_WHO_AM_I, &readOk);
  imuOk = (readOk && imuWhoAmI == EXPECTED_WHO_AM_I);
}

static void updateImuReadings() {
  bool readOk = false;
  imuWhoAmI = readImuRegister(REG_WHO_AM_I, &readOk);
  if (!readOk || imuWhoAmI != EXPECTED_WHO_AM_I) {
    imuOk = false;
    return;
  }

  Wire.beginTransmission(IMU_I2C_ADDR);
  Wire.write(REG_ACCEL_XOUT_H);
  if (Wire.endTransmission(false) != 0) {
    imuOk = false;
    return;
  }
  if (Wire.requestFrom(IMU_I2C_ADDR, (uint8_t)14, (uint8_t)true) != 14) {
    imuOk = false;
    return;
  }

  axRaw = (int16_t)((Wire.read() << 8) | Wire.read());
  ayRaw = (int16_t)((Wire.read() << 8) | Wire.read());
  azRaw = (int16_t)((Wire.read() << 8) | Wire.read());
  (void)Wire.read(); (void)Wire.read(); // Skip internal die temp
  gxRaw = (int16_t)((Wire.read() << 8) | Wire.read());
  gyRaw = (int16_t)((Wire.read() << 8) | Wire.read());
  gzRaw = (int16_t)((Wire.read() << 8) | Wire.read());

  imuOk = true;

  // Compute tilt roll/pitch from accelerometer (in tenths of a degree)
  float axf = (float)axRaw;
  float ayf = (float)ayRaw;
  float azf = (float)azRaw;
  float rollRad  = atan2(ayf, azf);
  float pitchRad = atan2(-axf, sqrt(ayf * ayf + azf * azf));
  rollDeciDeg  = (int16_t)(rollRad * 572.9578f);
  pitchDeciDeg = (int16_t)(pitchRad * 572.9578f);
}

static int16_t readTurbidityRawAdc() {
  uint32_t sum = 0;
  for (uint8_t i = 0; i < 4; i++) {
    sum += (uint16_t)analogRead(PIN_TURBIDITY);
  }
  return (int16_t)(sum >> 2);
}

static void sendTelemetryFrame() {
  updateImuReadings();
  int16_t turbAdc = readTurbidityRawAdc();
  char out[192];
  snprintf(
    out,
    sizeof(out),
    "VSTY/1 TELEM uptime_ms=%lu armed=%d estop=%d turb_raw=%d imu_ok=%d who_am_i=0x%02x ax=%d ay=%d az=%d gx=%d gy=%d gz=%d roll=%d pitch=%d m1=%d s1=%d\n",
    millis(),
    isArmed ? 1 : 0,
    isEstop ? 1 : 0,
    turbAdc,
    imuOk ? 1 : 0,
    imuWhoAmI,
    axRaw,
    ayRaw,
    azRaw,
    gxRaw,
    gyRaw,
    gzRaw,
    rollDeciDeg,
    pitchDeciDeg,
    currentMotor1Pwm,
    currentServo1Deg
  );
  Serial.print(out);
}

// ---------------- COMMAND PARSER ----------------
static bool extractKeyInt(const char *line, const char *key, long *outVal) {
  const char *p = strstr(line, key);
  if (!p) return false;
  p += strlen(key);
  char *endPtr = NULL;
  long v = strtol(p, &endPtr, 10);
  if (endPtr == p) return false;
  *outVal = v;
  return true;
}

static void handleCommandLine(char *line) {
  if (strncmp(line, "VSTY/1 ", 7) != 0) {
    Serial.print("VSTY/1 ERR seq=-1 cmd=UNKNOWN code=BAD_PROTOCOL msg=Expected_VSTY/1\n");
    return;
  }

  long seq = -1;
  if (!extractKeyInt(line, "seq=", &seq) || seq < 0) {
    Serial.print("VSTY/1 ERR seq=-1 cmd=UNKNOWN code=MISSING_SEQ msg=Missing_seq\n");
    return;
  }

  lastHostCommMs = millis();

  if (strstr(line, " HELLO") != NULL) {
    updateImuReadings();
    char out[140];
    snprintf(
      out,
      sizeof(out),
      "VSTY/1 ACK seq=%ld cmd=HELLO board=UNO_R3 fw=1.0.0 armed=%d estop=%d imu_ok=%d who_am_i=0x%02x\n",
      seq,
      isArmed ? 1 : 0,
      isEstop ? 1 : 0,
      imuOk ? 1 : 0,
      imuWhoAmI
    );
    Serial.print(out);
    sendTelemetryFrame();
    return;
  }

  if (strstr(line, " PING") != NULL) {
    char out[80];
    snprintf(out, sizeof(out), "VSTY/1 ACK seq=%ld cmd=PING armed=%d estop=%d\n", seq, isArmed ? 1 : 0, isEstop ? 1 : 0);
    Serial.print(out);
    return;
  }

  if (strstr(line, " TELEM") != NULL) {
    char out[80];
    snprintf(out, sizeof(out), "VSTY/1 ACK seq=%ld cmd=TELEM armed=%d estop=%d\n", seq, isArmed ? 1 : 0, isEstop ? 1 : 0);
    Serial.print(out);
    sendTelemetryFrame();
    return;
  }

  if (strstr(line, " ESTOP") != NULL) {
    isEstop = true;
    disarmAndStopAll();
    char out[96];
    snprintf(out, sizeof(out), "VSTY/1 ACK seq=%ld cmd=ESTOP armed=0 estop=1 m1=0\n", seq);
    Serial.print(out);
    return;
  }

  if (strstr(line, " STOP") != NULL) {
    disarmAndStopAll();
    char out[96];
    snprintf(out, sizeof(out), "VSTY/1 ACK seq=%ld cmd=STOP armed=0 estop=%d m1=0\n", seq, isEstop ? 1 : 0);
    Serial.print(out);
    return;
  }

  if (strstr(line, " CLEAR_ESTOP") != NULL) {
    isEstop = false;
    disarmAndStopAll();
    char out[96];
    snprintf(out, sizeof(out), "VSTY/1 ACK seq=%ld cmd=CLEAR_ESTOP armed=0 estop=0\n", seq);
    Serial.print(out);
    return;
  }

  if (strstr(line, " DISARM") != NULL) {
    disarmAndStopAll();
    char out[96];
    snprintf(out, sizeof(out), "VSTY/1 ACK seq=%ld cmd=DISARM armed=0 estop=%d\n", seq, isEstop ? 1 : 0);
    Serial.print(out);
    return;
  }

  if (strstr(line, " ARM") != NULL) {
    if (isEstop) {
      char out[96];
      snprintf(out, sizeof(out), "VSTY/1 ERR seq=%ld cmd=ARM code=ESTOP_ACTIVE msg=Clear_ESTOP_before_arming\n", seq);
      Serial.print(out);
      return;
    }
    applyMotor1SafeZero();
    applyServo1Deg(SERVO_NEUTRAL_DEG);
    isArmed = true;
    char out[96];
    snprintf(out, sizeof(out), "VSTY/1 ACK seq=%ld cmd=ARM armed=1 estop=0\n", seq);
    Serial.print(out);
    return;
  }

  if (strstr(line, " MOTOR") != NULL) {
    if (isEstop || !isArmed) {
      char out[96];
      snprintf(out, sizeof(out), "VSTY/1 ERR seq=%ld cmd=MOTOR code=NOT_ARMED msg=Controller_disarmed_or_in_ESTOP\n", seq);
      Serial.print(out);
      return;
    }
    long ch = 0, pwm = 0, durMs = 0;
    if (!extractKeyInt(line, "ch=", &ch) || !extractKeyInt(line, "pwm=", &pwm) || !extractKeyInt(line, "dur_ms=", &durMs)) {
      char out[96];
      snprintf(out, sizeof(out), "VSTY/1 ERR seq=%ld cmd=MOTOR code=BAD_PARAMS msg=Missing_ch_pwm_or_dur_ms\n", seq);
      Serial.print(out);
      return;
    }
    if (ch != 1) {
      char out[96];
      snprintf(out, sizeof(out), "VSTY/1 ERR seq=%ld cmd=MOTOR code=UNSUPPORTED_CH msg=Only_ch_1_enabled_in_stage_1\n", seq);
      Serial.print(out);
      return;
    }
    if (durMs < 100 || durMs > 5000) {
      char out[96];
      snprintf(out, sizeof(out), "VSTY/1 ERR seq=%ld cmd=MOTOR code=BAD_DURATION msg=Duration_must_be_100_to_5000ms\n", seq);
      Serial.print(out);
      return;
    }
    applyMotor1Pwm((int16_t)pwm);
    motor1StopAtMs = millis() + (unsigned long)durMs;
    char out[112];
    snprintf(out, sizeof(out), "VSTY/1 ACK seq=%ld cmd=MOTOR ch=1 pwm=%d dur_ms=%ld armed=1\n", seq, currentMotor1Pwm, durMs);
    Serial.print(out);
    return;
  }

  if (strstr(line, " SERVO") != NULL) {
    if (isEstop || !isArmed) {
      char out[96];
      snprintf(out, sizeof(out), "VSTY/1 ERR seq=%ld cmd=SERVO code=NOT_ARMED msg=Controller_disarmed_or_in_ESTOP\n", seq);
      Serial.print(out);
      return;
    }
    long ch = 0, deg = SERVO_NEUTRAL_DEG;
    if (!extractKeyInt(line, "ch=", &ch) || !extractKeyInt(line, "deg=", &deg) || ch != 1) {
      char out[96];
      snprintf(out, sizeof(out), "VSTY/1 ERR seq=%ld cmd=SERVO code=BAD_PARAMS msg=Invalid_servo_channel_or_deg\n", seq);
      Serial.print(out);
      return;
    }
    applyServo1Deg((int16_t)deg);
    char out[96];
    snprintf(out, sizeof(out), "VSTY/1 ACK seq=%ld cmd=SERVO ch=1 deg=%d armed=1\n", seq, currentServo1Deg);
    Serial.print(out);
    return;
  }

  char out[96];
  snprintf(out, sizeof(out), "VSTY/1 ERR seq=%ld cmd=UNKNOWN code=UNKNOWN_CMD msg=Unrecognized_command\n", seq);
  Serial.print(out);
}

void setup() {
  pinMode(PIN_M1_ENA, OUTPUT);
  pinMode(PIN_M1_IN1, OUTPUT);
  pinMode(PIN_M1_IN2, OUTPUT);
  applyMotor1SafeZero();

  servo1.attach(PIN_SERVO1);
  applyServo1Deg(SERVO_NEUTRAL_DEG);

  Serial.begin(115200);
  initImu();

  lastHostCommMs = millis();
  lastTelemSentMs = millis();

  char bootMsg[112];
  snprintf(
    bootMsg,
    sizeof(bootMsg),
    "VSTY/1 HELLO board=UNO_R3 fw=1.0.0 imu=0x%02x watchdog_ms=%lu\n",
    imuWhoAmI,
    WATCHDOG_TIMEOUT_MS
  );
  Serial.print(bootMsg);
}

void loop() {
  unsigned long now = millis();

  // 1. Read bounded serial lines non-blockingly
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      if (rxOverflow) {
        Serial.print("VSTY/1 ERR seq=-1 cmd=LINE code=LINE_OVERFLOW msg=Input_exceeded_127_bytes\n");
        rxOverflow = false;
      } else if (rxLen > 0) {
        rxBuf[rxLen] = '\0';
        handleCommandLine(rxBuf);
      }
      rxLen = 0;
    } else {
      if (rxLen < RX_BUF_SIZE - 1) {
        rxBuf[rxLen++] = c;
      } else {
        rxOverflow = true;
      }
    }
  }

  // 2. Enforce per-command motor duration timeout
  if (currentMotor1Pwm != 0 && motor1StopAtMs > 0 && (long)(now - motor1StopAtMs) >= 0) {
    applyMotor1SafeZero();
  }

  // 3. Enforce controller communication watchdog
  if (isArmed && (now - lastHostCommMs > WATCHDOG_TIMEOUT_MS)) {
    disarmAndStopAll();
    Serial.print("VSTY/1 EVENT type=WATCHDOG_TIMEOUT msg=Propulsion_cut_to_zero\n");
  }

  // 4. Periodic telemetry frame
  if (now - lastTelemSentMs >= TELEM_INTERVAL_MS) {
    lastTelemSentMs = now;
    sendTelemetryFrame();
  }
}
