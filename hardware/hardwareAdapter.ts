import {
  HardwareConfig,
  HardwareOperatingMode,
  loadHardwareConfig,
} from "./config.js";
import {
  CommandResult,
  ControllerCommunicationService,
} from "./controllerService.js";
import { Esp32CameraService } from "./cameraService.js";
import { SerialTransport } from "./transport.js";

export interface SimulatedRobotState {
  name: string;
  version: string;
  mode: string;
  status: string;
  speed: number;
  max_speed: number;
  direction: string;
  running: boolean;
  paused: boolean;
  battery: number;
  signal: number;
  camera: string;
  ai: string;
  light: string;
  emergency: boolean;
  temperature: number;
  ph: number;
  turbidity: number;
  ultrasonic: number;
  latitude: number;
  longitude: number;
  heading: number;
  waypoints: Array<{ lat: number; lng: number }>;
  current_waypoint: number;
  total_waypoints: number;
  distance: number;
  remaining_distance: number;
  eta: number;
  mission_name: string;
  inspection_type: string;
  progress: number;
  return_home_active: boolean;
}

export class HardwareAdapter {
  public config: HardwareConfig;
  public readonly controller: ControllerCommunicationService;
  public readonly camera: Esp32CameraService;

  constructor(config: HardwareConfig = loadHardwareConfig()) {
    this.config = config;
    this.controller = new ControllerCommunicationService(this.config);
    this.camera = new Esp32CameraService(this.config);
  }

  public get mode(): HardwareOperatingMode {
    return this.config.mode;
  }

  public async setOperatingMode(newMode: HardwareOperatingMode): Promise<{
    mode: HardwareOperatingMode;
    disarmed: boolean;
    message: string;
  }> {
    // Always disarm and stop propulsion when switching modes
    if (this.controller.isConnected) {
      await this.controller.stopPropulsion().catch(() => {});
    }
    this.config = {
      ...this.config,
      mode: newMode,
    };
    this.controller.updateConfig(this.config);
    this.camera.updateConfig(this.config);

    return {
      mode: this.config.mode,
      disarmed: true,
      message: `Switched backend operating mode to ${newMode}. Propulsion is disarmed and set to neutral/zero.`,
    };
  }

  public async connectController(customTransport?: SerialTransport): Promise<CommandResult> {
    return this.controller.connect(customTransport);
  }

  public async disconnectController(): Promise<void> {
    await this.controller.disconnect();
  }

  /**
   * Build `/api/sensors` response preserving the Array shape expected by `Dashboard.jsx` and `SensorCard.jsx`.
   * Never substitutes simulated values when `REAL` mode is active.
   */
  public getSensorsResponse(simState: SimulatedRobotState) {
    if (this.config.mode === "SIMULATION") {
      return [
        {
          name: "🌡 Temperature",
          value: simState.temperature,
          unit: "°C",
          status: "OK",
          error: null,
          solution: null,
          simulated: true,
          hardwareMode: "SIMULATION",
          sensorState: "SIMULATED",
        },
        {
          name: "💧 pH Level",
          value: simState.ph,
          unit: "",
          status: "OK",
          error: null,
          solution: null,
          simulated: true,
          hardwareMode: "SIMULATION",
          sensorState: "SIMULATED",
        },
        {
          name: "🌊 Turbidity",
          value: simState.turbidity,
          unit: "NTU",
          status: "OK",
          error: null,
          solution: null,
          simulated: true,
          hardwareMode: "SIMULATION",
          sensorState: "SIMULATED",
          rawAdc: null,
          calibrated: false,
        },
        {
          name: "📏 Depth",
          value: simState.progress,
          unit: "m",
          status: "OK",
          error: null,
          solution: null,
          simulated: true,
          hardwareMode: "SIMULATION",
          sensorState: "SIMULATED",
        },
        {
          name: "🔋 12V Li-Ion Battery",
          value: simState.battery,
          unit: "%",
          status: simState.battery > 20 ? "OK" : "WARNING",
          error: null,
          solution: null,
          simulated: true,
          hardwareMode: "SIMULATION",
          sensorState: "SIMULATED",
        },
      ];
    }

    // REAL HARDWARE MODE — strictly honest sensor reporting; zero fabricated readings
    const turb = this.controller.evaluateTurbidity();
    const imu = this.controller.evaluateImu();

    return [
      {
        name: "🌡 Temperature",
        value: "N/A",
        unit: "°C",
        status: "WARNING",
        error: this.config.sensors.temperature.installed
          ? "Temperature sensor telemetry not received from controller."
          : "DS18B20 temperature sensor is not installed in the current physical build.",
        solution: "Do not use software estimates; wire and confirm DS18B20 before enabling.",
        simulated: false,
        hardwareMode: "REAL",
        sensorState: this.config.sensors.temperature.installed ? "DISCONNECTED" : "NOT_INSTALLED",
      },
      {
        name: "💧 pH Level",
        value: "N/A",
        unit: "",
        status: "WARNING",
        error: this.config.sensors.ph.installed
          ? "pH sensor telemetry not received from controller."
          : "Analog pH sensor is not installed in the current physical build.",
        solution: "Never display software estimates as water pH measurements.",
        simulated: false,
        hardwareMode: "REAL",
        sensorState: this.config.sensors.ph.installed ? "DISCONNECTED" : "NOT_INSTALLED",
      },
      {
        name: "🌊 Turbidity",
        value: turb.displayValue,
        unit: turb.displayUnit,
        status: turb.cardStatus,
        error: turb.error,
        solution: turb.solution,
        simulated: false,
        hardwareMode: "REAL",
        sensorState: turb.state,
        rawAdc: turb.rawAdc,
        voltage: turb.voltage,
        calibrated: turb.calibrated,
        ntuEstimate: turb.ntuEstimate,
        timestampMs: turb.timestampMs,
      },
      {
        name: "📏 Depth",
        value: imu.imuOk && imu.pitchDeg !== null ? `Pitch ${imu.pitchDeg.toFixed(1)}°` : "N/A",
        unit: "",
        status: imu.imuOk ? "OK" : "WARNING",
        error: imu.imuOk
          ? null
          : "Depth pressure sensor not installed; MPU-6500 IMU orientation unavailable.",
        solution: imu.imuOk
          ? null
          : "Connect Arduino controller and verify MPU-6500 IMU at I2C 0x68 (WHO_AM_I=0x70).",
        simulated: false,
        hardwareMode: "REAL",
        sensorState: imu.state,
        imuRollDeg: imu.rollDeg,
        imuPitchDeg: imu.pitchDeg,
        imuWhoAmI: imu.whoAmI,
      },
      {
        name: "🔋 12V Li-Ion Battery",
        value: "Unmonitored",
        unit: "",
        status: "WARNING",
        error: "3S 11.1V LiPo voltage divider sense line is not wired to Arduino ADC.",
        solution: "Use an external LiPo low-voltage buzzer/checker on the 3S balance lead during operation.",
        simulated: false,
        hardwareMode: "REAL",
        sensorState: "NOT_INSTALLED",
      },
    ];
  }

  /**
   * Build `/api/health` response preserving the 6-item Array shape expected by `HealthPanel.jsx`.
   */
  public getHealthResponse(simState: SimulatedRobotState) {
    if (this.config.mode === "SIMULATION") {
      return [
        {
          name: "🔋 12V Li-Ion Battery",
          value: `${simState.battery}% (Sim)`,
          width: `${simState.battery}%`,
          color: simState.battery > 20 ? "#00ff88" : "#ff4444",
          status: simState.battery > 20 ? "OK" : "WARNING",
          error: null,
          solution: null,
          simulated: true,
        },
        {
          name: "📡 ESP32-CAM WiFi Network",
          value: this.camera.status.online
            ? `Verified (${this.camera.status.latencyMs ?? 0}ms)`
            : "Simulated Standby",
          width: this.camera.status.online ? "100%" : "80%",
          color: "#00d4ff",
          status: "OK",
          error: null,
          solution: null,
          simulated: !this.camera.status.online,
        },
        {
          name: "⚙️ L298N Motor Driver",
          value: "Simulated (Safe)",
          width: "100%",
          color: "#00ff88",
          status: "OK",
          error: null,
          solution: null,
          simulated: true,
        },
        {
          name: "🧭 MPU-6500 IMU (0x68)",
          value: "Simulated",
          width: "100%",
          color: "#7b61ff",
          status: "OK",
          error: null,
          solution: null,
          simulated: true,
        },
        {
          name: "🧠 Arduino UNO R3 (Master MCU)",
          value: "Simulation Mode",
          width: "100%",
          color: "#ff9800",
          status: "OK",
          error: null,
          solution: null,
          simulated: true,
        },
        {
          name: "❤️ Overall Health",
          value: "98% (Sim)",
          width: "98%",
          color: "#00ff88",
          status: "OK",
          error: null,
          solution: null,
          simulated: true,
        },
      ];
    }

    // REAL HARDWARE MODE
    const ctrlConnected = this.controller.isConnected && !this.controller.isTelemetryStale();
    const imu = this.controller.evaluateImu();
    const camOnline = this.camera.status.online;
    const estop = this.controller.isEstopLatched;

    const motorStatusOk = ctrlConnected && !estop;
    const overallHealthy = ctrlConnected && imu.imuOk && !estop;

    return [
      {
        name: "🔋 3S 11.1V LiPo Battery",
        value: "External Check Req",
        width: "50%",
        color: "#ff9800",
        status: "WARNING",
        error: "No battery voltage divider connected to Arduino ADC.",
        solution: "Attach 3S LiPo alarm to balance connector; do not discharge below 3.5V/cell (10.5V).",
        simulated: false,
      },
      {
        name: "📡 ESP32-CAM WiFi Network",
        value: camOnline ? `Online (${this.camera.status.latencyMs ?? 0}ms)` : "Offline / Unverified",
        width: camOnline ? "100%" : "20%",
        color: camOnline ? "#00ff88" : "#ff4444",
        status: camOnline ? "OK" : "ERROR",
        error: camOnline ? null : this.camera.status.message,
        solution: camOnline
          ? null
          : "Power ESP32-CAM via 5V regulator, join same Wi-Fi LAN, and click Connect Camera.",
        simulated: false,
      },
      {
        name: "⚙️ L298N Motor Driver",
        value: estop
          ? "EMERGENCY STOP"
          : !ctrlConnected
          ? "Controller Offline"
          : this.controller.isArmed
          ? `Armed (${this.config.propulsion.allowedStage})`
          : "Disarmed (Safe 0 PWM)",
        width: motorStatusOk ? "100%" : "20%",
        color: estop ? "#ff4444" : ctrlConnected ? "#00ff88" : "#ff9800",
        status: estop ? "ERROR" : ctrlConnected ? "OK" : "WARNING",
        error: estop
          ? "Emergency stop is latched — all propulsion outputs forced to zero."
          : !this.config.propulsion.confirmedByEngineer
          ? "Propulsion locked until L298N count, motor current, and 5V servo supply are verified."
          : null,
        solution: estop
          ? "Inspect robot, then call /api/hardware/clear-estop when safe."
          : !this.config.propulsion.confirmedByEngineer
          ? "Verify 2x L298N wiring and set PROPULSION_CONFIRMED=true in .env for bench tests."
          : null,
        simulated: false,
      },
      {
        name: "🧭 MPU-6500 IMU (0x68)",
        value: imu.imuOk ? `Online (${imu.whoAmI})` : "Offline / Unverified",
        width: imu.imuOk ? "100%" : "15%",
        color: imu.imuOk ? "#00ff88" : "#ff4444",
        status: imu.imuOk ? "OK" : "ERROR",
        error: imu.imuOk
          ? null
          : "MPU-6500 IMU at I2C 0x68 (expected WHO_AM_I 0x70) not confirmed by controller.",
        solution: imu.imuOk
          ? null
          : "Check I2C SDA (A4) / SCL (A5) wiring and 3.3V/5V module supply on Arduino UNO R3.",
        simulated: false,
      },
      {
        name: "🧠 Arduino UNO R3 (Master MCU)",
        value: ctrlConnected
          ? `Connected (${this.controller.controllerInfo.controllerBoard})`
          : "Disconnected",
        width: ctrlConnected ? "100%" : "10%",
        color: ctrlConnected ? "#00ff88" : "#ff4444",
        status: ctrlConnected ? "OK" : "ERROR",
        error: ctrlConnected
          ? null
          : this.controller.lastError ||
            `No verified controller handshake on ${this.config.controller.serialPort || "unconfigured SERIAL_PORT"}.`,
        solution: ctrlConnected
          ? null
          : "Connect Arduino UNO R3 via USB, set SERIAL_PORT in .env, and call /api/hardware/connect.",
        simulated: false,
      },
      {
        name: "❤️ Overall Health",
        value: overallHealthy ? "Ready (Hardware)" : "Attention Needed",
        width: overallHealthy ? "95%" : "35%",
        color: overallHealthy ? "#00ff88" : "#ff9800",
        status: overallHealthy ? "OK" : "WARNING",
        error: overallHealthy
          ? null
          : "One or more physical hardware subsystems are disconnected or unverified.",
        solution: overallHealthy
          ? null
          : "Review controller, IMU, and ESP32-CAM connection cards above.",
        simulated: false,
      },
    ];
  }

  public getStatusResponse(simState: SimulatedRobotState) {
    if (this.config.mode === "SIMULATION") {
      return {
        status: simState.status,
        mode: simState.mode,
        running: simState.running,
        emergency: simState.emergency,
        battery: parseFloat(simState.battery.toFixed(1)),
        signal: parseFloat(simState.signal.toFixed(1)),
        hardwareMode: "SIMULATION",
        simulated: true,
        controllerConnected: false,
        armed: false,
      };
    }

    const connected = this.controller.isConnected && !this.controller.isTelemetryStale();
    const estop = this.controller.isEstopLatched || simState.emergency;
    return {
      status: estop
        ? "EMERGENCY_STOP"
        : !connected
        ? "HARDWARE_DISCONNECTED"
        : this.controller.isArmed
        ? "HARDWARE_ARMED"
        : "HARDWARE_READY_DISARMED",
      mode: "REAL_HARDWARE",
      running: Boolean(connected && this.controller.isArmed && !estop),
      emergency: estop,
      battery: 0, // Unmonitored without ADC divider; do not fabricate 100%
      signal: connected ? 100 : 0,
      hardwareMode: "REAL",
      simulated: false,
      controllerConnected: connected,
      armed: this.controller.isArmed,
    };
  }

  public getTelemetryResponse(
    simState: SimulatedRobotState,
    eventLogs: Array<{ type: string; message: string; time: string }>
  ) {
    if (this.config.mode === "SIMULATION") {
      return {
        latitude: parseFloat(simState.latitude.toFixed(6)),
        longitude: parseFloat(simState.longitude.toFixed(6)),
        heading: simState.heading,
        speed: parseFloat(simState.speed.toFixed(2)),
        battery: parseFloat(simState.battery.toFixed(1)),
        signal: parseFloat(simState.signal.toFixed(1)),
        status: simState.status,
        mode: simState.mode,
        progress: simState.progress,
        currentWaypoint: simState.current_waypoint,
        totalWaypoints: simState.total_waypoints,
        distance: simState.distance,
        remainingDistance: simState.remaining_distance,
        eta: simState.eta,
        camera: simState.camera,
        ai: simState.ai,
        temperature: simState.temperature,
        ph: simState.ph,
        turbidity: simState.turbidity,
        ultrasonic: simState.ultrasonic,
        event_logs: eventLogs.slice(0, 15),
        hardwareMode: "SIMULATION",
        simulated: true,
      };
    }

    const connected = this.controller.isConnected && !this.controller.isTelemetryStale();
    const turb = this.controller.evaluateTurbidity();
    const imu = this.controller.evaluateImu();
    const telem = this.controller.lastTelemetry;

    return {
      latitude: parseFloat(simState.latitude.toFixed(6)),
      longitude: parseFloat(simState.longitude.toFixed(6)),
      heading: 0, // MPU-6500 has no magnetometer; do not report gyro yaw as absolute compass heading
      speed: 0,
      battery: 0,
      signal: connected ? 100 : 0,
      status: this.controller.isEstopLatched
        ? "EMERGENCY_STOP"
        : connected
        ? this.controller.isArmed
          ? "HARDWARE_ARMED"
          : "HARDWARE_STANDBY"
        : "HARDWARE_DISCONNECTED",
      mode: "REAL_HARDWARE",
      progress: 0,
      currentWaypoint: simState.current_waypoint,
      totalWaypoints: simState.total_waypoints,
      distance: simState.distance,
      remainingDistance: simState.remaining_distance,
      eta: 0,
      camera: this.camera.status.online ? "ONLINE" : "OFFLINE",
      ai: simState.ai,
      temperature: null,
      ph: null,
      turbidity: turb.calibrated ? turb.ntuEstimate : turb.rawAdc,
      ultrasonic: null,
      event_logs: eventLogs.slice(0, 15),
      hardwareMode: "REAL",
      simulated: false,
      controllerConnected: connected,
      telemetryTimestampMs: telem?.receivedAtMs ?? null,
      telemetryStale: this.controller.isTelemetryStale(),
      turbidityDetail: turb,
      imuDetail: imu,
      actuators: {
        armed: this.controller.isArmed,
        estop: this.controller.isEstopLatched,
        motor1Pwm: telem?.motor1Pwm ?? 0,
        servo1Deg: telem?.servo1Deg ?? this.config.propulsion.servoNeutralDeg,
      },
    };
  }

  public async getDiagnosticsStatus() {
    const discoveredPorts = await this.controller.listAvailablePorts();
    return {
      operatingMode: this.config.mode,
      isCloudEnvironment: this.config.isCloudEnvironment,
      controller: this.controller.controllerInfo,
      discoveredSerialPorts: discoveredPorts,
      turbidity: this.controller.evaluateTurbidity(),
      imu: this.controller.evaluateImu(),
      camera: this.camera.status,
      propulsionConfig: {
        confirmedByEngineer: this.config.propulsion.confirmedByEngineer,
        l298nModuleCount: this.config.propulsion.l298nModuleCount,
        thrusterGeometryConfirmed: this.config.propulsion.thrusterGeometryConfirmed,
        allowedStage: this.config.propulsion.allowedStage,
        maxSafeBenchPwm: this.config.propulsion.maxSafeBenchPwm,
        maxMotorDurationMs: this.config.propulsion.maxMotorDurationMs,
        servoBoundsDeg: [
          this.config.propulsion.servoMinDeg,
          this.config.propulsion.servoMaxDeg,
        ],
        servoNeutralDeg: this.config.propulsion.servoNeutralDeg,
        pins: this.config.propulsion.pins,
      },
      electricalSafetyNotes: [
        "One L298N module provides only 2 H-bridge channels (2A continuous/channel max). Four independent R385 motors require at least 2x L298N modules or higher-current MOSFET drivers.",
        "Do NOT power MG90S servos from L298N motor outputs or directly from the 3S 11.1V LiPo; use a dedicated 5V UBEC/buck regulator (>= 3A) with common GND.",
        "On Arduino UNO R3, standard Servo.h uses Timer1 and disables analogWrite() PWM on D9 and D10; use D3, D5, D6, or D11 for L298N ENA/ENB speed PWM.",
      ],
    };
  }
}
