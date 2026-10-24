import dotenv from "dotenv";

dotenv.config();

export type HardwareOperatingMode = "SIMULATION" | "REAL";
export type ControllerBoardModel = "ARDUINO_UNO_R3" | "ARDUINO_NANO" | "UNCONFIRMED";
export type PropulsionStage = "DISABLED" | "SINGLE_CHANNEL_BENCH";

export interface HardwareConfig {
  mode: HardwareOperatingMode;
  isCloudEnvironment: boolean;
  controller: {
    boardModel: ControllerBoardModel;
    serialPort: string;
    baudRate: number;
    handshakeTimeoutMs: number;
    commandTimeoutMs: number;
    telemetryStaleMs: number;
    watchdogTimeoutMs: number;
    reconnectIntervalMs: number;
  };
  sensors: {
    turbidity: {
      installed: boolean;
      analogPin: string;
      adcResolutionBits: number;
      vRefVolts: number;
      minValidAdc: number;
      maxValidAdc: number;
      calibrated: boolean;
      calibrationSlope: number | null;
      calibrationOffset: number | null;
    };
    imu: {
      installed: boolean;
      i2cAddressHex: string;
      expectedWhoAmIHex: string;
    };
    gps: {
      installed: boolean;
      surfaceOnlyWarning: string;
    };
    ultrasonic: {
      installed: boolean;
    };
    temperature: {
      installed: boolean;
    };
    ph: {
      installed: boolean;
    };
    depth: {
      installed: boolean;
    };
    batterySense: {
      installed: boolean;
    };
  };
  propulsion: {
    confirmedByEngineer: boolean;
    l298nModuleCount: number;
    thrusterGeometryConfirmed: boolean;
    fullPropulsionSupportedByFirmware: false;
    allowedStage: PropulsionStage;
    motorRatedVoltageV: number;
    batteryNominalVoltageV: number;
    maxSafeBenchPwm: number;
    maxMotorDurationMs: number;
    servoMinDeg: number;
    servoMaxDeg: number;
    servoNeutralDeg: number;
    pins: {
      motor1EnaPin: string;
      motor1In1Pin: string;
      motor1In2Pin: string;
      servo1SignalPin: string;
    };
  };
  camera: {
    streamUrl: string;
    snapshotUrl: string;
    defaultIp: string;
    fallbackIp: string;
    defaultStreamPort: number;
    defaultCapturePort: number;
    defaultStreamPath: string;
    defaultCapturePath: string;
    pingTimeoutMs: number;
    snapshotTimeoutMs: number;
    isVerified: boolean;
    autoConnect: boolean;
    reconnectIntervalMs: number;
  };
}

function parseOptionalNumber(val: string | undefined): number | null {
  if (val === undefined || val.trim() === "") return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function parseBoardModel(raw: string | undefined): ControllerBoardModel {
  const normalized = (raw || "").trim().toUpperCase();
  if (normalized === "ARDUINO_UNO_R3" || normalized === "UNO_R3" || normalized === "UNO") {
    return "ARDUINO_UNO_R3";
  }
  if (normalized === "ARDUINO_NANO" || normalized === "NANO") {
    return "ARDUINO_NANO";
  }
  return "UNCONFIRMED";
}

function resolveTurbidityCalibration(env: NodeJS.ProcessEnv): {
  calibrated: boolean;
  slope: number | null;
  offset: number | null;
} {
  if (env.TURBIDITY_CALIBRATED !== "true") {
    return { calibrated: false, slope: null, offset: null };
  }

  // Option A: Direct linear calibration constants (NTU = slope * V + offset)
  const directSlope = parseOptionalNumber(env.TURBIDITY_CAL_SLOPE);
  const directOffset = parseOptionalNumber(env.TURBIDITY_CAL_OFFSET);
  if (directSlope !== null && directOffset !== null) {
    return { calibrated: true, slope: directSlope, offset: directOffset };
  }

  // Option B: Two-point reference standards from .env.example
  const clearV = parseOptionalNumber(env.TURBIDITY_CLEAR_WATER_VOLTAGE);
  const refV = parseOptionalNumber(env.TURBIDITY_REFERENCE_NTU_VOLTAGE);
  const refNtu = parseOptionalNumber(env.TURBIDITY_REFERENCE_NTU_VALUE);
  if (
    clearV !== null &&
    refV !== null &&
    refNtu !== null &&
    Math.abs(refV - clearV) > 0.05 &&
    refNtu > 0
  ) {
    const slope = refNtu / (refV - clearV);
    const offset = -slope * clearV;
    return { calibrated: true, slope, offset };
  }

  return { calibrated: false, slope: null, offset: null };
}

export function loadHardwareConfig(env: NodeJS.ProcessEnv = process.env): HardwareConfig {
  const rawMode = (env.HARDWARE_MODE || "SIMULATION").trim().toUpperCase();
  const mode: HardwareOperatingMode = rawMode === "REAL" ? "REAL" : "SIMULATION";

  const isCloudEnvironment = Boolean(env.VERCEL || env.RENDER || env.RENDER_SERVICE_ID);

  const boardModel = parseBoardModel(env.CONTROLLER_BOARD);
  const confirmedByEngineer = env.PROPULSION_CONFIRMED === "true";
  const l298nModuleCount = Math.max(0, parseInt(env.L298N_MODULE_COUNT || "0", 10) || 0);
  const thrusterGeometryConfirmed = env.THRUSTER_GEOMETRY_CONFIRMED === "true";

  // Stage-1 firmware (`vsty_uno_controller.ino`) supports ONLY 1 motor channel (M1) and 1 servo (S1).
  // Never enable 4-motor full propulsion merely by setting environment variables.
  let allowedStage: PropulsionStage = "DISABLED";
  if (confirmedByEngineer && boardModel !== "UNCONFIRMED" && l298nModuleCount >= 1) {
    allowedStage = "SINGLE_CHANNEL_BENCH";
  }

  const turbCal = resolveTurbidityCalibration(env);

  const maxPwmRaw = env.STAGE1_MAX_PWM || env.MAX_SAFE_BENCH_PWM || "140";
  const maxDurRaw = env.STAGE1_MAX_DURATION_MS || env.MAX_MOTOR_DURATION_MS || "2000";
  const servoMinRaw = env.STAGE1_SERVO_MIN_DEG || env.SERVO_MIN_DEG || "45";
  const servoMaxRaw = env.STAGE1_SERVO_MAX_DEG || env.SERVO_MAX_DEG || "135";

  const camTimeoutDefault = parseInt(env.ESP32_CAM_TIMEOUT_MS || "5000", 10) || 5000;

  return {
    mode,
    isCloudEnvironment,
    controller: {
      boardModel,
      serialPort: (env.SERIAL_PORT || "").trim(),
      baudRate: parseInt(env.SERIAL_BAUD_RATE || "115200", 10) || 115200,
      handshakeTimeoutMs: parseInt(env.SERIAL_HANDSHAKE_TIMEOUT_MS || "3500", 10) || 3500,
      commandTimeoutMs: parseInt(env.SERIAL_COMMAND_TIMEOUT_MS || "1500", 10) || 1500,
      telemetryStaleMs: parseInt(env.TELEMETRY_STALE_MS || "3000", 10) || 3000,
      watchdogTimeoutMs: parseInt(env.CONTROLLER_WATCHDOG_MS || "2000", 10) || 2000,
      reconnectIntervalMs: parseInt(env.SERIAL_RECONNECT_MS || "5000", 10) || 5000,
    },
    sensors: {
      turbidity: {
        installed: env.TURBIDITY_INSTALLED !== "false",
        analogPin: (env.TURBIDITY_ANALOG_PIN || "A0").trim(),
        adcResolutionBits: 10,
        vRefVolts: parseFloat(env.CONTROLLER_VREF_VOLTS || "5.0") || 5.0,
        minValidAdc: parseInt(env.TURBIDITY_MIN_VALID_ADC || "5", 10) || 5,
        maxValidAdc: parseInt(env.TURBIDITY_MAX_VALID_ADC || "1018", 10) || 1018,
        calibrated: turbCal.calibrated,
        calibrationSlope: turbCal.slope,
        calibrationOffset: turbCal.offset,
      },
      imu: {
        installed: env.IMU_INSTALLED !== "false",
        i2cAddressHex: "0x68",
        expectedWhoAmIHex: "0x70",
      },
      gps: {
        installed: env.GPS_MODULE_INSTALLED === "true" || env.GPS_INSTALLED === "true",
        surfaceOnlyWarning:
          "NEO-6M GPS is a surface-only positioning aid. RF satellite signals do not penetrate water reliably.",
      },
      ultrasonic: {
        installed:
          env.ULTRASONIC_SENSOR_INSTALLED === "true" || env.ULTRASONIC_INSTALLED === "true",
      },
      temperature: {
        installed:
          env.TEMPERATURE_SENSOR_INSTALLED === "true" || env.TEMP_SENSOR_INSTALLED === "true",
      },
      ph: {
        installed: env.PH_SENSOR_INSTALLED === "true",
      },
      depth: {
        installed: env.DEPTH_SENSOR_INSTALLED === "true",
      },
      batterySense: {
        installed: env.BATTERY_SENSE_INSTALLED === "true",
      },
    },
    propulsion: {
      confirmedByEngineer,
      l298nModuleCount,
      thrusterGeometryConfirmed,
      fullPropulsionSupportedByFirmware: false,
      allowedStage,
      motorRatedVoltageV: parseFloat(env.MOTOR_RATED_VOLTAGE_V || "12.0") || 12.0,
      batteryNominalVoltageV: parseFloat(env.BATTERY_NOMINAL_VOLTAGE_V || "11.1") || 11.1,
      maxSafeBenchPwm: Math.min(180, Math.max(0, parseInt(maxPwmRaw, 10) || 140)),
      maxMotorDurationMs: Math.min(3000, Math.max(100, parseInt(maxDurRaw, 10) || 2000)),
      servoMinDeg: Math.max(45, parseInt(servoMinRaw, 10) || 45),
      servoMaxDeg: Math.min(135, parseInt(servoMaxRaw, 10) || 135),
      servoNeutralDeg: parseInt(env.SERVO_NEUTRAL_DEG || "90", 10) || 90,
      pins: {
        motor1EnaPin: (env.MOTOR1_ENA_PIN || "D5").trim(),
        motor1In1Pin: (env.MOTOR1_IN1_PIN || "D7").trim(),
        motor1In2Pin: (env.MOTOR1_IN2_PIN || "D8").trim(),
        servo1SignalPin: (env.SERVO1_SIGNAL_PIN || "D9").trim(),
      },
    },
    camera: {
      streamUrl: (env.ESP32_CAM_STREAM_URL || "").trim(),
      snapshotUrl: (env.ESP32_CAM_SNAPSHOT_URL || "").trim(),
      defaultIp: (env.ESP32_CAM_IP || env.VITE_ESP_DEFAULT_IP || "192.168.1.100").trim(),
      fallbackIp: (env.ESP32_CAM_FALLBACK_IP || "").trim(),
      defaultStreamPort:
        parseInt(env.ESP32_CAM_STREAM_PORT || env.VITE_ESP_DEFAULT_PORT || "81", 10) || 81,
      defaultCapturePort: parseInt(env.ESP32_CAM_CAPTURE_PORT || "80", 10) || 80,
      defaultStreamPath: (
        env.ESP32_CAM_STREAM_PATH ||
        env.VITE_ESP_DEFAULT_PATH ||
        "/stream"
      ).trim(),
      defaultCapturePath: (env.ESP32_CAM_CAPTURE_PATH || "/capture").trim(),
      pingTimeoutMs:
        parseInt(env.ESP32_CAM_PING_TIMEOUT_MS || String(camTimeoutDefault), 10) ||
        camTimeoutDefault,
      snapshotTimeoutMs:
        parseInt(env.ESP32_CAM_SNAPSHOT_TIMEOUT_MS || String(camTimeoutDefault), 10) ||
        camTimeoutDefault,
      isVerified: env.ESP32_CAM_VERIFIED === "true",
      autoConnect: env.ESP32_CAM_AUTO_CONNECT !== "false",
      reconnectIntervalMs:
        parseInt(env.ESP32_CAM_RECONNECT_MS || "5000", 10) || 5000,
    },
  };
}
