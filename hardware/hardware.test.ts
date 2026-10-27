import assert from "node:assert/strict";
import { loadHardwareConfig } from "./config.js";
import { parseControllerLine, formatHostCommand } from "./protocol.js";
import { MockSerialTransport } from "./transport.js";
import { ControllerCommunicationService } from "./controllerService.js";
import { validateCamUrl, extractFirstJpegFrame, Esp32CameraService } from "./cameraService.js";
import { HardwareAdapter, SimulatedRobotState } from "./hardwareAdapter.js";

let passed = 0;
let failed = 0;

async function runTest(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed++;
    console.log(`  [PASS] ${name}`);
  } catch (err: any) {
    failed++;
    console.error(`  [FAIL] ${name}:`, err?.message || err);
  }
}

async function main() {
  console.log("==========================================================");
  console.log("VSTY SUBMERSIBLE MICRO ROBOT — HARDWARE & API TEST SUITE");
  console.log("==========================================================\n");

  // ----------------------------------------------------------
  // 1. PROTOCOL PARSING & FORMATTING TESTS
  // ----------------------------------------------------------
  console.log("1. Protocol Parsing & Command Formatting (VSTY/1):");

  await runTest("Parses valid HELLO frame with MPU-6500 WHO_AM_I=0x70", () => {
    const res = parseControllerLine("VSTY/1 HELLO fw=1.0.0 board=UNO_R3 imu=0x70 watchdog_ms=2000");
    assert.equal(res.ok, true);
    if (res.ok && res.frame?.type === "HELLO") {
      assert.equal(res.frame.fw, "1.0.0");
      assert.equal(res.frame.board, "UNO_R3");
      assert.equal(res.frame.imuWhoAmI, "0x70");
      assert.equal(res.frame.watchdogMs, 2000);
    } else {
      assert.fail("Expected HELLO frame");
    }
  });

  await runTest("Parses valid TELEM frame with turbidity ADC and MPU-6500 IMU data", () => {
    const line =
      "VSTY/1 TELEM uptime_ms=12400 armed=0 estop=0 turb_raw=720 imu_ok=1 who_am_i=0x70 ax=120 ay=-40 az=16380 gx=12 gy=-5 gz=1 roll=12 pitch=-4 m1=0 s1=90";
    const res = parseControllerLine(line);
    assert.equal(res.ok, true);
    if (res.ok && res.frame?.type === "TELEM") {
      assert.equal(res.frame.uptimeMs, 12400);
      assert.equal(res.frame.armed, false);
      assert.equal(res.frame.estop, false);
      assert.equal(res.frame.turbRawAdc, 720);
      assert.equal(res.frame.imuOk, true);
      assert.equal(res.frame.whoAmI, "0x70");
      assert.equal(res.frame.rollDeg, 1.2);
      assert.equal(res.frame.pitchDeg, -0.4);
    } else {
      assert.fail("Expected TELEM frame");
    }
  });

  await runTest("Rejects malformed, truncated, implausible ADC, and oversized serial lines", () => {
    const badPrefix = parseControllerLine("GARBAGE HELLO fw=1.0");
    assert.equal(badPrefix.ok, false);

    const badAdc = parseControllerLine(
      "VSTY/1 TELEM uptime_ms=100 armed=0 estop=0 turb_raw=2048 imu_ok=1 who_am_i=0x70"
    );
    assert.equal(badAdc.ok, false);

    const oversized = parseControllerLine("VSTY/1 " + "A".repeat(300));
    assert.equal(oversized.ok, false);
  });

  await runTest("Formats bounded host commands and rejects invalid seq or verb", () => {
    assert.equal(formatHostCommand(1, "ESTOP"), "VSTY/1 seq=1 ESTOP\n");
    assert.equal(
      formatHostCommand(2, "MOTOR", { ch: 1, pwm: 100, dur_ms: 500 }),
      "VSTY/1 seq=2 MOTOR ch=1 pwm=100 dur_ms=500\n"
    );
    assert.equal(
      formatHostCommand(3, "SERVO", { ch: 1, deg: 90 }),
      "VSTY/1 seq=3 SERVO ch=1 deg=90\n"
    );
    assert.throws(() => formatHostCommand(-1, "ESTOP"));
    assert.throws(() => formatHostCommand(4, "BAD VERB"));
  });

  // ----------------------------------------------------------
  // 2. CONTROLLER SERVICE: HANDSHAKE, TIMEOUT, DISCONNECT & SENSORS
  // ----------------------------------------------------------
  console.log("\n2. Controller Communication Service (Handshake, Timeouts, Sensors, Safety):");

  await runTest("Completes controller handshake and parses live MPU-6500 + turbidity telemetry", async () => {
    const cfg = loadHardwareConfig({
      HARDWARE_MODE: "REAL",
      CONTROLLER_BOARD: "ARDUINO_UNO_R3",
      SERIAL_PORT: "MOCK_COM3",
      PROPULSION_CONFIRMED: "true",
      L298N_MODULE_COUNT: "1",
      TURBIDITY_CALIBRATED: "false",
    });

    const transport = new MockSerialTransport("MOCK_COM3", {
      onHostWrite: (line, t) => {
        const m = line.match(/^VSTY\/1 seq=(\d+) (\S+)/);
        if (!m) return;
        const seq = m[1];
        const cmd = m[2];
        if (cmd === "HELLO") {
          t.receiveFromController(
            `VSTY/1 ACK seq=${seq} cmd=HELLO board=UNO_R3 fw=1.0.0 imu=0x70 armed=0 estop=0`
          );
          t.receiveFromController(
            "VSTY/1 TELEM uptime_ms=500 armed=0 estop=0 turb_raw=680 imu_ok=1 who_am_i=0x70 ax=10 ay=20 az=16300 gx=0 gy=0 gz=1 roll=5 pitch=11 m1=0 s1=90"
          );
        } else {
          t.receiveFromController(`VSTY/1 ACK seq=${seq} cmd=${cmd}`);
        }
      },
    });

    const svc = new ControllerCommunicationService(cfg);
    const conn = await svc.connect(transport);
    assert.equal(conn.ok, true);
    assert.equal(conn.confirmedByController, true);

    assert.equal(svc.isConnected, true);
    assert.equal(svc.isArmed, false);

    // Turbidity should be UNCALIBRATED_RAW (honest ADC + Voltage, ntuEstimate = null)
    const turb = svc.evaluateTurbidity();
    assert.equal(turb.state, "UNCALIBRATED_RAW");
    assert.equal(turb.rawAdc, 680);
    assert.equal(turb.calibrated, false);
    assert.equal(turb.ntuEstimate, null);
    assert.ok(turb.voltage !== null && Math.abs(turb.voltage - (680 * 5.0) / 1023) < 0.02);

    // IMU should be CALIBRATED/OK with WHO_AM_I = 0x70
    const imu = svc.evaluateImu();
    assert.equal(imu.imuOk, true);
    assert.equal(imu.whoAmI, "0x70");
    assert.equal(imu.rollDeg, 0.5);
    assert.equal(imu.pitchDeg, 1.1);

    await svc.disconnect();
  });

  await runTest("Detects turbidity open/short rail fault (ADC=0 or ADC=1023)", async () => {
    const cfg = loadHardwareConfig({
      HARDWARE_MODE: "REAL",
      CONTROLLER_BOARD: "ARDUINO_UNO_R3",
      SERIAL_PORT: "MOCK_COM3",
    });
    const transport = new MockSerialTransport("MOCK_COM3", {
      onHostWrite: (line, t) => {
        const m = line.match(/^VSTY\/1 seq=(\d+) (\S+)/);
        if (!m) return;
        t.receiveFromController(`VSTY/1 ACK seq=${m[1]} cmd=${m[2]} board=UNO_R3 fw=1.0.0 imu=0x70`);
      },
    });

    const svc = new ControllerCommunicationService(cfg);
    await svc.connect(transport);
    transport.receiveFromController(
      "VSTY/1 TELEM uptime_ms=900 armed=0 estop=0 turb_raw=0 imu_ok=1 who_am_i=0x70 ax=0 ay=0 az=16384 gx=0 gy=0 gz=0 roll=0 pitch=0 m1=0 s1=90"
    );

    const turb = svc.evaluateTurbidity();
    assert.equal(turb.state, "FAULT");
    assert.equal(turb.ntuEstimate, null);
    assert.equal(turb.cardStatus, "ERROR");
    await svc.disconnect();
  });

  await runTest("Handles command timeout honestly when firmware does not ACK", async () => {
    const cfg = loadHardwareConfig({
      HARDWARE_MODE: "REAL",
      CONTROLLER_BOARD: "ARDUINO_UNO_R3",
      SERIAL_PORT: "MOCK_COM3",
      SERIAL_COMMAND_TIMEOUT_MS: "150",
    });
    const transport = new MockSerialTransport("MOCK_COM3", {
      onHostWrite: (line, t) => {
        const m = line.match(/^VSTY\/1 seq=(\d+) (\S+)/);
        if (!m) return;
        if (m[2] === "HELLO") {
          t.receiveFromController(`VSTY/1 ACK seq=${m[1]} cmd=HELLO board=UNO_R3 fw=1.0.0 imu=0x70`);
        }
        // Do NOT ack STOP -> trigger timeout
      },
    });

    const svc = new ControllerCommunicationService(cfg);
    await svc.connect(transport);
    const stopRes = await svc.stopPropulsion();
    assert.equal(stopRes.ok, false);
    assert.equal(stopRes.confirmedByController, false);
    assert.equal(stopRes.code, "COMMAND_TIMEOUT");
    await svc.disconnect();
  });

  await runTest("Handles unexpected USB disconnect mid-command and resets armed state to false", async () => {
    const cfg = loadHardwareConfig({
      HARDWARE_MODE: "REAL",
      CONTROLLER_BOARD: "ARDUINO_UNO_R3",
      SERIAL_PORT: "MOCK_COM3",
      PROPULSION_CONFIRMED: "true",
      L298N_MODULE_COUNT: "1",
    });
    const transport = new MockSerialTransport("MOCK_COM3", {
      onHostWrite: (line, t) => {
        const m = line.match(/^VSTY\/1 seq=(\d+) (\S+)/);
        if (!m) return;
        const seq = m[1];
        const cmd = m[2];
        if (cmd === "HELLO") {
          t.receiveFromController(`VSTY/1 ACK seq=${seq} cmd=HELLO board=UNO_R3 fw=1.0.0 imu=0x70`);
        } else if (cmd === "ARM") {
          t.receiveFromController(`VSTY/1 ACK seq=${seq} cmd=ARM armed=1 estop=0`);
        } else if (cmd === "MOTOR") {
          // Simulate USB cable yanked mid-command before ACK
          t.simulateDisconnect("USB cable unplugged");
        }
      },
    });

    const svc = new ControllerCommunicationService(cfg);
    await svc.connect(transport);
    const armRes = await svc.armPropulsion();
    assert.equal(armRes.ok, true);
    assert.equal(svc.isArmed, true);

    const motorRes = await svc.commandSingleMotor(1, 100, 500);
    assert.equal(motorRes.ok, false);
    assert.equal(motorRes.confirmedByController, false);
    assert.equal(motorRes.code, "DISCONNECTED");
    assert.equal(svc.isConnected, false);
    assert.equal(svc.isArmed, false);
  });

  await runTest("Enforces Stage-1 propulsion gates (disarmed block, PWM limit, multi-channel block, ESTOP override)", async () => {
    const cfg = loadHardwareConfig({
      HARDWARE_MODE: "REAL",
      CONTROLLER_BOARD: "ARDUINO_UNO_R3",
      SERIAL_PORT: "MOCK_COM3",
      PROPULSION_CONFIRMED: "true",
      L298N_MODULE_COUNT: "1",
      MAX_SAFE_BENCH_PWM: "140",
      MAX_MOTOR_DURATION_MS: "2000",
    });
    const transport = new MockSerialTransport("MOCK_COM3", {
      onHostWrite: (line, t) => {
        const m = line.match(/^VSTY\/1 seq=(\d+) (\S+)/);
        if (!m) return;
        const seq = m[1];
        const cmd = m[2];
        if (cmd === "ARM") {
          t.receiveFromController(`VSTY/1 ACK seq=${seq} cmd=ARM armed=1 estop=0`);
        } else if (cmd === "ESTOP") {
          t.receiveFromController(`VSTY/1 ACK seq=${seq} cmd=ESTOP armed=0 estop=1`);
        } else {
          t.receiveFromController(`VSTY/1 ACK seq=${seq} cmd=${cmd} board=UNO_R3 fw=1.0.0 imu=0x70`);
        }
      },
    });

    const svc = new ControllerCommunicationService(cfg);
    await svc.connect(transport);

    // 1. Motor command must be rejected while DISARMED
    const disarmedTry = await svc.commandSingleMotor(1, 90, 500);
    assert.equal(disarmedTry.ok, false);
    assert.equal(disarmedTry.code, "NOT_ARMED");

    // 2. Arm and test PWM limit enforcement & multi-channel gate
    await svc.armPropulsion();
    const overPwmTry = await svc.commandSingleMotor(1, 220, 500);
    assert.equal(overPwmTry.ok, false);
    assert.equal(overPwmTry.code, "PWM_LIMIT_EXCEEDED");

    const ch2Try = await svc.commandSingleMotor(2, 80, 500);
    assert.equal(ch2Try.ok, false);
    assert.equal(ch2Try.code, "MULTI_MOTOR_UNCONFIRMED");

    const validMotorTry = await svc.commandSingleMotor(1, 100, 600);
    assert.equal(validMotorTry.ok, true);
    assert.equal(validMotorTry.confirmedByController, true);

    // 3. Trigger ESTOP -> must confirm and block subsequent motor/servo commands
    const estopRes = await svc.emergencyStop();
    assert.equal(estopRes.ok, true);
    assert.equal(estopRes.confirmedByController, true);
    assert.equal(svc.isEstopLatched, true);
    assert.equal(svc.isArmed, false);

    const afterEstopTry = await svc.commandSingleMotor(1, 80, 400);
    assert.equal(afterEstopTry.ok, false);
    assert.equal(afterEstopTry.code, "ESTOP_ACTIVE");

    await svc.disconnect();
  });

  // ----------------------------------------------------------
  // 3. ESP32-CAM SSRF & MJPEG FRAME EXTRACTION TESTS
  // ----------------------------------------------------------
  console.log("\n3. ESP32-CAM Security & MJPEG Snapshot Extraction:");

  await runTest("SSRF guard allows private RFC-1918 LAN IPs and rejects loopback/cloud metadata/public IPs", () => {
    assert.equal(validateCamUrl("http://192.168.1.184:81/stream").ok, true);
    assert.equal(validateCamUrl("http://10.42.0.55/capture").ok, true);
    assert.equal(validateCamUrl("http://esp32cam.local/capture").ok, true);

    assert.equal(validateCamUrl("http://127.0.0.1:3000/api/hardware/status").ok, false);
    assert.equal(validateCamUrl("http://localhost:3000/api/health").ok, false);
    assert.equal(validateCamUrl("http://169.254.169.254/latest/meta-data").ok, false);
    assert.equal(validateCamUrl("http://8.8.8.8/stream").ok, false);
    assert.equal(validateCamUrl("ftp://192.168.1.50/file").ok, false);
  });

  await runTest("Extracts complete JPEG frame (0xFFD8..0xFFD9) from MJPEG multipart buffer", () => {
    const header = Buffer.from("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 8\r\n\r\n", "ascii");
    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0xde, 0xad, 0xff, 0xd9]);
    const trailer = Buffer.from("\r\n--frame\r\n", "ascii");
    const combined = Buffer.concat([header, fakeJpeg, trailer]);

    const extracted = extractFirstJpegFrame(combined);
    assert.ok(extracted !== null);
    assert.deepEqual(extracted, fakeJpeg);

    const incomplete = Buffer.from([0xff, 0xd8, 0x01, 0x02]);
    assert.equal(extractFirstJpegFrame(incomplete), null);
  });

  await runTest("Loads backend authoritative camera config and constructs correct stream/capture URLs", () => {
    const cfg = loadHardwareConfig({
      ESP32_CAM_IP: "192.168.1.184",
      ESP32_CAM_STREAM_PORT: "81",
      ESP32_CAM_CAPTURE_PORT: "80",
      ESP32_CAM_STREAM_PATH: "/stream",
      ESP32_CAM_CAPTURE_PATH: "/capture",
      ESP32_CAM_VERIFIED: "true",
      ESP32_CAM_AUTO_CONNECT: "true",
    });

    const camSvc = new Esp32CameraService(cfg);
    const backendConfig = camSvc.getCameraConfig();

    assert.equal(backendConfig.ip, "192.168.1.184");
    assert.equal(backendConfig.streamPort, 81);
    assert.equal(backendConfig.capturePort, 80);
    assert.equal(backendConfig.streamUrl, "http://192.168.1.184:81/stream");
    assert.equal(backendConfig.captureUrl, "http://192.168.1.184:80/capture");
    assert.equal(backendConfig.isVerified, true);
    assert.equal(backendConfig.autoConnect, true);

    // Test runtime reconfiguration
    const updated = camSvc.updateRuntimeCameraConfig({
      ip: "10.0.0.55",
      streamPort: 8080,
      streamPath: "/video",
    });
    assert.equal(updated.config.ip, "10.0.0.55");
    assert.equal(updated.config.streamPort, 8080);
    assert.equal(updated.config.streamUrl, "http://10.0.0.55:8080/video");
    assert.equal(camSvc.getDefaultStreamUrl(), "http://10.0.0.55:8080/video");
  });

  await runTest("Auto-connect lifecycle and status listener manage background timers safely", () => {
    const cfg = loadHardwareConfig({
      ESP32_CAM_IP: "192.168.1.184",
      ESP32_CAM_AUTO_CONNECT: "true",
      ESP32_CAM_RECONNECT_MS: "1000",
    });

    const camSvc = new Esp32CameraService(cfg);
    let notified = false;
    const unsubscribe = camSvc.onStatusChange((_status) => {
      notified = true;
    });

    // Start auto-connect, verify it doesn't crash or hang, and stops cleanly
    camSvc.startAutoConnect();
    camSvc.stopAutoConnect();
    unsubscribe();
    assert.equal(typeof camSvc.status.online, "boolean");
  });

  await runTest("Sanitizes frontend camera config and never exposes private IP or raw URLs to client", () => {
    const cfg = loadHardwareConfig({
      ESP32_CAM_IP: "192.168.1.184",
      ESP32_CAM_STREAM_PORT: "81",
      ESP32_CAM_STREAM_PATH: "/stream",
      ESP32_CAM_CAPTURE_PORT: "80",
      ESP32_CAM_CAPTURE_PATH: "/capture",
      ESP32_CAM_AUTO_CONNECT: "true",
      ESP32_CAM_RECONNECT_INTERVAL_MS: "6000",
    });

    assert.equal(cfg.camera.reconnectIntervalMs, 6000);
    const camSvc = new Esp32CameraService(cfg);
    const internalCfg = camSvc.getCameraConfig();

    // Frontend sanitized config payload contract
    const frontendPayload = {
      proxyStreamUrl: "/api/camera/stream",
      autoConnect: internalCfg.autoConnect,
      isVerified: internalCfg.isVerified,
      isCloudEnvironment: internalCfg.isCloudEnvironment,
    };

    assert.equal((frontendPayload as any).ip, undefined);
    assert.equal((frontendPayload as any).streamUrl, undefined);
    assert.equal((frontendPayload as any).captureUrl, undefined);
    assert.equal((frontendPayload as any).streamPort, undefined);
    assert.equal(frontendPayload.proxyStreamUrl, "/api/camera/stream");
    assert.equal(frontendPayload.autoConnect, true);
  });

  await runTest("Resolves fixed backend stream target and ignores arbitrary client URLs", () => {
    const cfg = loadHardwareConfig({
      ESP32_CAM_IP: "192.168.1.200",
      ESP32_CAM_STREAM_PORT: "81",
      ESP32_CAM_STREAM_PATH: "/stream",
      ESP32_CAM_CAPTURE_PORT: "80",
      ESP32_CAM_CAPTURE_PATH: "/capture",
    });
    const camSvc = new Esp32CameraService(cfg);

    // The stream target must always be the configured default
    assert.equal(camSvc.getDefaultStreamUrl(), "http://192.168.1.200:81/stream");
    assert.equal(camSvc.getDefaultCaptureUrl(), "http://192.168.1.200:80/capture");
  });

  await runTest("Resolves stream URL from ESP32_CAM_STREAM_URL and reports truthful offline status", async () => {
    const cfg = loadHardwareConfig({
      ESP32_CAM_STREAM_URL: "http://10.41.235.60/stream",
      ESP32_CAM_AUTO_CONNECT: "false",
      ESP32_CAM_TIMEOUT_MS: "300",
    });

    assert.equal(cfg.camera.streamUrl, "http://10.41.235.60/stream");
    const camSvc = new Esp32CameraService(cfg);
    assert.equal(camSvc.getDefaultStreamUrl(), "http://10.41.235.60/stream");
    assert.equal(camSvc.getDefaultCaptureUrl(), "http://10.41.235.60:80/capture");

    // Ping will fail honestly because camera is powered off
    const status = await camSvc.pingCamera(camSvc.getDefaultStreamUrl());
    assert.equal(status.online, false);
    // Ensure message does not expose internal IP
    assert.ok(!status.message.includes("10.41.235.60"));
  });

  // ----------------------------------------------------------
  // 4. BACKEND API CONTRACT & CONFIG ALIGNMENT TESTS
  // ----------------------------------------------------------
  console.log("\n4. Frontend-Backend API Contract & Config Alignment:");

  await runTest("Applies .env.example settings and keeps 4-motor full propulsion disabled for Stage-1 firmware", () => {
    const cfg = loadHardwareConfig({
      HARDWARE_MODE: "REAL",
      CONTROLLER_BOARD: "ARDUINO_UNO_R3",
      SERIAL_HANDSHAKE_TIMEOUT_MS: "4200",
      STAGE1_MAX_PWM: "125",
      STAGE1_MAX_DURATION_MS: "1800",
      STAGE1_SERVO_MIN_DEG: "50",
      STAGE1_SERVO_MAX_DEG: "130",
      TEMPERATURE_SENSOR_INSTALLED: "true",
      DEPTH_SENSOR_INSTALLED: "false",
      GPS_MODULE_INSTALLED: "true",
      ULTRASONIC_SENSOR_INSTALLED: "true",
      BATTERY_SENSE_INSTALLED: "false",
      PROPULSION_CONFIRMED: "true",
      L298N_MODULE_COUNT: "2",
      THRUSTER_GEOMETRY_CONFIRMED: "true",
      TURBIDITY_CALIBRATED: "true",
      TURBIDITY_CLEAR_WATER_VOLTAGE: "4.10",
      TURBIDITY_REFERENCE_NTU_VOLTAGE: "2.50",
      TURBIDITY_REFERENCE_NTU_VALUE: "1000",
      ESP32_CAM_STREAM_URL: "http://192.168.1.50:81/stream",
      ESP32_CAM_SNAPSHOT_URL: "http://192.168.1.50/capture",
      ESP32_CAM_TIMEOUT_MS: "4500",
    });

    assert.equal(cfg.controller.handshakeTimeoutMs, 4200);
    assert.equal(cfg.propulsion.maxSafeBenchPwm, 125);
    assert.equal(cfg.propulsion.maxMotorDurationMs, 1800);
    assert.equal(cfg.propulsion.servoMinDeg, 50);
    assert.equal(cfg.propulsion.servoMaxDeg, 130);
    assert.equal(cfg.sensors.temperature.installed, true);
    assert.equal(cfg.sensors.depth.installed, false);
    assert.equal(cfg.sensors.gps.installed, true);
    assert.equal(cfg.sensors.ultrasonic.installed, true);
    assert.equal(cfg.sensors.batterySense.installed, false);
    assert.equal(cfg.sensors.turbidity.calibrated, true);
    assert.ok(cfg.sensors.turbidity.calibrationSlope !== null);
    assert.equal(cfg.camera.streamUrl, "http://192.168.1.50:81/stream");
    assert.equal(cfg.camera.snapshotUrl, "http://192.168.1.50/capture");
    assert.equal(cfg.camera.pingTimeoutMs, 4500);
    assert.equal(cfg.camera.snapshotTimeoutMs, 4500);

    // Full 4-motor propulsion must NEVER be enabled via env vars while firmware is Stage-1 only
    assert.equal(cfg.propulsion.fullPropulsionSupportedByFirmware, false);
    assert.equal(cfg.propulsion.allowedStage, "SINGLE_CHANNEL_BENCH");
  });

  await runTest("Preserves exact Dashboard/SensorCard/HealthPanel array contracts and never reports IMU pitch as Depth", async () => {
    const adapter = new HardwareAdapter(
      loadHardwareConfig({
        HARDWARE_MODE: "SIMULATION",
      })
    );

    const simRobotState: SimulatedRobotState = {
      name: "VSTY",
      version: "1.0.0",
      mode: "AUTONOMOUS",
      status: "IDLE",
      speed: 0,
      max_speed: 2.5,
      direction: "STOP",
      running: false,
      paused: false,
      battery: 98.4,
      signal: 99.1,
      camera: "ONLINE",
      ai: "READY",
      light: "OFF",
      emergency: false,
      temperature: 18.4,
      ph: 7.2,
      turbidity: 14.5,
      ultrasonic: 12.4,
      latitude: 13.0827,
      longitude: 80.2707,
      heading: 45,
      waypoints: [],
      current_waypoint: 0,
      total_waypoints: 3,
      distance: 1.2,
      remaining_distance: 1.2,
      eta: 15,
      mission_name: "Test Mission",
      inspection_type: "Pipeline",
      progress: 1.5,
      return_home_active: false,
    };

    // SIMULATION mode checks
    const simSensors = adapter.getSensorsResponse(simRobotState);
    assert.ok(Array.isArray(simSensors));
    assert.equal(simSensors.length, 5);
    assert.ok(simSensors.every((s) => s.simulated === true && s.hardwareMode === "SIMULATION"));

    const simHealth = adapter.getHealthResponse(simRobotState);
    assert.ok(Array.isArray(simHealth));
    assert.equal(simHealth.length, 6);
    assert.ok(simHealth.every((h) => typeof h.name === "string" && typeof h.status === "string"));

    // Switch to REAL mode and connect mock controller with active IMU pitch (1.5 deg)
    await adapter.setOperatingMode("REAL");
    const transport = new MockSerialTransport("MOCK_COM3", {
      onHostWrite: (line, t) => {
        const m = line.match(/^VSTY\/1 seq=(\d+) (\S+)/);
        if (!m) return;
        t.receiveFromController(`VSTY/1 ACK seq=${m[1]} cmd=${m[2]} board=UNO_R3 fw=1.0.0 imu=0x70`);
        t.receiveFromController(
          "VSTY/1 TELEM uptime_ms=1000 armed=0 estop=0 turb_raw=700 imu_ok=1 who_am_i=0x70 ax=10 ay=20 az=16300 gx=0 gy=0 gz=0 roll=5 pitch=15 m1=0 s1=90"
        );
      },
    });
    await adapter.connectController(transport);

    const realSensors = adapter.getSensorsResponse(simRobotState);
    assert.ok(Array.isArray(realSensors));
    assert.equal(realSensors.length, 5);
    for (const card of realSensors) {
      assert.equal(card.simulated, false);
      assert.equal(card.hardwareMode, "REAL");
    }
    // Temperature & pH must report N/A (never simulated numbers)
    assert.equal(realSensors[0].value, "N/A");
    assert.equal(realSensors[1].value, "N/A");
    // Depth card must report N/A (never IMU pitch!) even when IMU is online with pitch=1.5°
    const depthCard = realSensors[3];
    assert.equal(depthCard.name, "📏 Depth");
    assert.equal(depthCard.value, "N/A");
    assert.equal(depthCard.unit, "m");
    assert.equal(depthCard.status, "WARNING");
    assert.equal(depthCard.sensorState, "NOT_INSTALLED");

    const realTelemetry = adapter.getTelemetryResponse(simRobotState, []);
    assert.equal(realTelemetry.hardwareMode, "REAL");
    assert.equal(realTelemetry.simulated, false);
    assert.equal(realTelemetry.temperature, null);
    assert.equal(realTelemetry.ph, null);
    assert.equal(realTelemetry.ultrasonic, null);
    assert.equal(realTelemetry.battery, 0);

    await adapter.disconnectController();
  });

  console.log(`\n==========================================================`);
  console.log(`TEST SUMMARY: ${passed} passed, ${failed} failed`);
  console.log(`==========================================================`);

  if (failed > 0) {
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("Unhandled test runner error:", err);
  process.exit(1);
});
