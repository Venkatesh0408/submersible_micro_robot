import {
  HardwareConfig,
  loadHardwareConfig,
} from "./config.js";
import {
  formatHostCommand,
  parseControllerLine,
  ParsedAckFrame,
  ParsedErrFrame,
  ParsedTelemFrame,
  PROTOCOL_VERSION,
} from "./protocol.js";
import {
  discoverSerialPorts,
  PhysicalSerialTransport,
  SerialTransport,
} from "./transport.js";
import { logger } from "../logger.js";

export type SensorReadinessState =
  | "CALIBRATED"
  | "UNCALIBRATED_RAW"
  | "FAULT"
  | "STALE"
  | "DISCONNECTED"
  | "NOT_INSTALLED";

export interface TurbidityReading {
  state: SensorReadinessState;
  rawAdc: number | null;
  voltage: number | null;
  calibrated: boolean;
  ntuEstimate: number | null;
  displayValue: number | string;
  displayUnit: string;
  cardStatus: "OK" | "WARNING" | "ERROR";
  error: string | null;
  solution: string | null;
  timestampMs: number | null;
}

export interface ImuReading {
  state: SensorReadinessState;
  imuOk: boolean;
  whoAmI: string;
  rollDeg: number | null;
  pitchDeg: number | null;
  accelRaw: { ax: number; ay: number; az: number } | null;
  gyroRaw: { gx: number; gy: number; gz: number } | null;
  yawNote: string;
  timestampMs: number | null;
}

export interface CommandResult {
  ok: boolean;
  confirmedByController: boolean;
  seq?: number;
  cmd: string;
  code?: string;
  message: string;
  fields?: Record<string, string>;
}

interface PendingCommand {
  seq: number;
  cmd: string;
  resolve: (res: CommandResult) => void;
  timer: NodeJS.Timeout;
}

export class ControllerCommunicationService {
  private config: HardwareConfig;
  private transport: SerialTransport | null = null;
  private seqCounter = 1;
  private pendingCommands = new Map<number, PendingCommand>();

  private _connected = false;
  private _handshakeVerified = false;
  private _controllerBoard = "UNKNOWN";
  private _firmwareVersion = "UNKNOWN";
  private _armed = false;
  private _estopLatched = false;
  private _lastTelem: ParsedTelemFrame | null = null;
  private _lastError: string | null = null;
  private _recentEvents: Array<{ time: string; type: string; message: string }> = [];

  constructor(config: HardwareConfig = loadHardwareConfig()) {
    this.config = config;
  }

  public updateConfig(config: HardwareConfig): void {
    this.config = config;
  }

  public get isConnected(): boolean {
    return Boolean(this._connected && this.transport?.isOpen && this._handshakeVerified);
  }

  public get isArmed(): boolean {
    return this.isConnected && this._armed && !this._estopLatched;
  }

  public get isEstopLatched(): boolean {
    return this._estopLatched;
  }

  public get lastTelemetry(): ParsedTelemFrame | null {
    return this._lastTelem;
  }

  public get lastError(): string | null {
    return this._lastError;
  }

  public get controllerInfo() {
    return {
      connected: this.isConnected,
      transportOpen: Boolean(this.transport?.isOpen),
      handshakeVerified: this._handshakeVerified,
      portPath: this.transport?.portPath || this.config.controller.serialPort || null,
      baudRate: this.config.controller.baudRate,
      protocolVersion: PROTOCOL_VERSION,
      controllerBoard: this._controllerBoard,
      configuredBoard: this.config.controller.boardModel,
      firmwareVersion: this._firmwareVersion,
      armed: this.isArmed,
      estopLatched: this._estopLatched,
      lastError: this._lastError,
      telemetryReceivedAtMs: this._lastTelem?.receivedAtMs ?? null,
      telemetryStale: this.isTelemetryStale(),
      recentEvents: this._recentEvents.slice(0, 15),
    };
  }

  public isTelemetryStale(nowMs: number = Date.now()): boolean {
    if (!this._lastTelem) return true;
    return nowMs - this._lastTelem.receivedAtMs > this.config.controller.telemetryStaleMs;
  }

  private recordEvent(type: string, message: string): void {
    this._recentEvents.unshift({
      time: new Date().toISOString(),
      type,
      message,
    });
    if (this._recentEvents.length > 50) {
      this._recentEvents.length = 50;
    }
  }

  private resetToSafeDisconnectedState(reason: string): void {
    this._connected = false;
    this._handshakeVerified = false;
    this._armed = false;
    this._lastError = reason;

    // Fail all in-flight commands immediately so callers never assume physical execution succeeded
    for (const [seq, pending] of this.pendingCommands.entries()) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        confirmedByController: false,
        seq,
        cmd: pending.cmd,
        code: "DISCONNECTED",
        message: `Controller disconnected before acknowledging '${pending.cmd}': ${reason}`,
      });
    }
    this.pendingCommands.clear();
  }

  /**
   * Connect to the controller using either an injected transport (for testing)
   * or a PhysicalSerialTransport for the configured serial port.
   */
  public async connect(customTransport?: SerialTransport): Promise<CommandResult> {
    if (this.config.isCloudEnvironment && !customTransport) {
      const msg =
        "Cannot connect to local USB serial controller from a cloud server (Vercel/Render). Run the backend on the local host physically connected to the Arduino.";
      this._lastError = msg;
      return {
        ok: false,
        confirmedByController: false,
        cmd: "CONNECT",
        code: "CLOUD_HOST_NO_LOCAL_HARDWARE",
        message: msg,
      };
    }

    await this.disconnect();

    const targetTransport =
      customTransport ||
      new PhysicalSerialTransport(
        this.config.controller.serialPort,
        this.config.controller.baudRate
      );

    this.transport = targetTransport;
    this._armed = false;

    targetTransport.onLine((line) => this.handleIncomingLine(line));
    targetTransport.onClose((reason) => {
      const msg = reason || "Serial connection closed";
      logger.warn(`[hardware] Controller serial closed: ${msg}`);
      this.recordEvent("DISCONNECT", msg);
      this.resetToSafeDisconnectedState(msg);
    });
    targetTransport.onError((err) => {
      logger.error(`[hardware] Serial transport error: ${err.message}`);
      this.recordEvent("SERIAL_ERROR", err.message);
      this._lastError = err.message;
    });

    try {
      await targetTransport.open();
      this._connected = true;
    } catch (err: any) {
      const msg = err?.message || "Failed to open serial transport";
      this.resetToSafeDisconnectedState(msg);
      return {
        ok: false,
        confirmedByController: false,
        cmd: "CONNECT",
        code: "OPEN_FAILED",
        message: msg,
      };
    }

    // Perform explicit HELLO handshake before considering the controller ready
    const helloRes = await this.sendRawCommand("HELLO", undefined, true);
    if (!helloRes.ok || !helloRes.confirmedByController) {
      await this.disconnect();
      const msg = `Controller handshake failed on '${targetTransport.portPath}': ${helloRes.message}`;
      this._lastError = msg;
      return {
        ok: false,
        confirmedByController: false,
        cmd: "HELLO",
        code: "HANDSHAKE_FAILED",
        message: msg,
      };
    }

    this._handshakeVerified = true;
    this._controllerBoard = helloRes.fields?.board || this._controllerBoard || "UNO_R3";
    this._firmwareVersion = helloRes.fields?.fw || this._firmwareVersion || "1.0.0";
    this._armed = false; // Always force disarmed on fresh connection
    this._estopLatched = helloRes.fields?.estop === "1";
    this._lastError = null;

    this.recordEvent(
      "CONNECTED",
      `Handshake verified (${this._controllerBoard}, fw=${this._firmwareVersion})`
    );
    logger.info(
      `[hardware] Controller connected on ${targetTransport.portPath} (${this._controllerBoard}, fw=${this._firmwareVersion})`
    );

    return {
      ok: true,
      confirmedByController: true,
      seq: helloRes.seq,
      cmd: "HELLO",
      message: `Connected to ${this._controllerBoard} (fw ${this._firmwareVersion})`,
      fields: helloRes.fields,
    };
  }

  public async disconnect(): Promise<void> {
    if (this.transport) {
      const t = this.transport;
      this.transport = null;
      t.removeAllListeners();
      try {
        if (t.isOpen) {
          await t.close();
        }
      } catch {
        // ignore close errors
      }
    }
    this.resetToSafeDisconnectedState("Disconnected");
  }

  private handleIncomingLine(line: string): void {
    const parsed = parseControllerLine(line, Date.now());
    if (!parsed.ok || !parsed.frame) {
      logger.warn(`[hardware] Ignored invalid controller line: ${parsed.error}`);
      this.recordEvent("PARSE_ERR", parsed.error || "Invalid frame");
      return;
    }

    const frame = parsed.frame;
    switch (frame.type) {
      case "HELLO": {
        this._controllerBoard = frame.board;
        this._firmwareVersion = frame.fw;
        this._armed = false; // Controller booted/reset: propulsion is disarmed
        this.recordEvent("CONTROLLER_BOOT", `Controller boot banner: ${frame.board} fw=${frame.fw}`);
        break;
      }

      case "ACK": {
        this.resolvePendingFromAck(frame);
        break;
      }

      case "ERR": {
        this.resolvePendingFromErr(frame);
        break;
      }

      case "TELEM": {
        this._lastTelem = frame;
        this._armed = frame.armed;
        this._estopLatched = frame.estop;
        break;
      }

      case "EVENT": {
        this.recordEvent(frame.eventType, frame.msg);
        if (frame.eventType === "WATCHDOG_TIMEOUT" || frame.eventType === "ESTOP") {
          this._armed = false;
        }
        break;
      }
    }
  }

  private resolvePendingFromAck(frame: ParsedAckFrame): void {
    const pending = this.pendingCommands.get(frame.seq);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(frame.seq);

    if (frame.fields.armed !== undefined) {
      this._armed = frame.fields.armed === "1";
    }
    if (frame.fields.estop !== undefined) {
      this._estopLatched = frame.fields.estop === "1";
    }

    pending.resolve({
      ok: true,
      confirmedByController: true,
      seq: frame.seq,
      cmd: frame.cmd,
      message: `Controller acknowledged ${frame.cmd}`,
      fields: frame.fields,
    });
  }

  private resolvePendingFromErr(frame: ParsedErrFrame): void {
    const pending = this.pendingCommands.get(frame.seq);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingCommands.delete(frame.seq);

    pending.resolve({
      ok: false,
      confirmedByController: false,
      seq: frame.seq,
      cmd: frame.cmd,
      code: frame.code,
      message: `Controller rejected ${frame.cmd}: ${frame.msg} (${frame.code})`,
      fields: frame.fields,
    });
  }

  private async sendRawCommand(
    cmd: string,
    params?: Record<string, string | number>,
    allowBeforeHandshake: boolean = false
  ): Promise<CommandResult> {
    if (!this.transport || !this.transport.isOpen || !this._connected) {
      return {
        ok: false,
        confirmedByController: false,
        cmd,
        code: "NOT_CONNECTED",
        message: `Cannot dispatch '${cmd}': controller is not connected.`,
      };
    }

    if (!allowBeforeHandshake && !this._handshakeVerified) {
      return {
        ok: false,
        confirmedByController: false,
        cmd,
        code: "HANDSHAKE_NOT_VERIFIED",
        message: `Cannot dispatch '${cmd}': controller handshake is not verified.`,
      };
    }

    const seq = this.seqCounter++;
    let formatted: string;
    try {
      formatted = formatHostCommand(seq, cmd, params);
    } catch (err: any) {
      return {
        ok: false,
        confirmedByController: false,
        seq,
        cmd,
        code: "INVALID_COMMAND_FORMAT",
        message: err?.message || "Invalid command parameters",
      };
    }

    const timeoutMs = this.config.controller.commandTimeoutMs;

    return new Promise<CommandResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingCommands.delete(seq);
        const msg = `Command '${cmd}' (seq=${seq}) timed out after ${timeoutMs}ms without controller acknowledgement.`;
        this._lastError = msg;
        this.recordEvent("COMMAND_TIMEOUT", msg);
        resolve({
          ok: false,
          confirmedByController: false,
          seq,
          cmd,
          code: "COMMAND_TIMEOUT",
          message: msg,
        });
      }, timeoutMs);

      this.pendingCommands.set(seq, { seq, cmd, resolve, timer });

      this.transport!.writeLine(formatted).catch((err: Error) => {
        clearTimeout(timer);
        this.pendingCommands.delete(seq);
        const msg = `Serial write failed for '${cmd}' (seq=${seq}): ${err.message}`;
        this._lastError = msg;
        resolve({
          ok: false,
          confirmedByController: false,
          seq,
          cmd,
          code: "WRITE_ERROR",
          message: msg,
        });
      });
    });
  }

  // ==========================================================
  // SAFETY & MOTION COMMANDS
  // ==========================================================

  public async emergencyStop(): Promise<CommandResult> {
    this._armed = false;
    this._estopLatched = true;
    this.recordEvent("ESTOP_REQUESTED", "Emergency stop triggered");

    if (!this.isConnected) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "ESTOP",
        code: "CONTROLLER_DISCONNECTED",
        message:
          "Software emergency stop latched, but physical controller is disconnected — physical stopping could NOT be confirmed. Disconnect battery power immediately.",
      };
    }

    const res = await this.sendRawCommand("ESTOP");
    if (res.ok && res.confirmedByController) {
      this._armed = false;
      this._estopLatched = true;
      return {
        ...res,
        message: "Emergency stop executed and confirmed by physical controller (all motors zeroed and disarmed).",
      };
    }

    return {
      ...res,
      ok: false,
      confirmedByController: false,
      message: `Software emergency stop latched, but controller did NOT confirm ESTOP (${res.message}). Disconnect battery power immediately.`,
    };
  }

  public async stopPropulsion(): Promise<CommandResult> {
    this._armed = false;
    if (!this.isConnected) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "STOP",
        code: "CONTROLLER_DISCONNECTED",
        message: "Propulsion disarmed in software, but physical controller is disconnected.",
      };
    }

    const res = await this.sendRawCommand("STOP");
    if (res.ok && res.confirmedByController) {
      this._armed = false;
    }
    return res;
  }

  public async clearEmergencyStop(): Promise<CommandResult> {
    this._armed = false;
    if (!this.isConnected) {
      this._estopLatched = false;
      return {
        ok: false,
        confirmedByController: false,
        cmd: "CLEAR_ESTOP",
        code: "CONTROLLER_DISCONNECTED",
        message: "Cleared software ESTOP latch only; controller is not connected.",
      };
    }
    const res = await this.sendRawCommand("CLEAR_ESTOP");
    if (res.ok && res.confirmedByController) {
      this._estopLatched = false;
      this._armed = false;
    }
    return res;
  }

  public async armPropulsion(): Promise<CommandResult> {
    if (this.config.mode !== "REAL") {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "ARM",
        code: "NOT_IN_REAL_MODE",
        message: "Cannot arm physical propulsion while HARDWARE_MODE is SIMULATION.",
      };
    }
    if (!this.config.propulsion.confirmedByEngineer) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "ARM",
        code: "PROPULSION_UNCONFIRMED",
        message:
          "Physical propulsion is locked: set PROPULSION_CONFIRMED=true, CONTROLLER_BOARD=ARDUINO_UNO_R3, and L298N_MODULE_COUNT in .env only after verifying motor current, L298N wiring, and regulated 5V servo power.",
      };
    }
    if (this.config.propulsion.allowedStage === "DISABLED") {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "ARM",
        code: "STAGE_DISABLED",
        message:
          "Propulsion stage is DISABLED. Confirm CONTROLLER_BOARD and L298N_MODULE_COUNT >= 1 before arming.",
      };
    }
    if (this._estopLatched) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "ARM",
        code: "ESTOP_ACTIVE",
        message: "Cannot arm propulsion while Emergency Stop is latched. Clear ESTOP first.",
      };
    }
    if (!this.isConnected) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "ARM",
        code: "CONTROLLER_DISCONNECTED",
        message: "Cannot arm propulsion: physical controller is not connected.",
      };
    }

    const res = await this.sendRawCommand("ARM");
    if (res.ok && res.confirmedByController) {
      this._armed = true;
    }
    return res;
  }

  public async disarmPropulsion(): Promise<CommandResult> {
    this._armed = false;
    if (!this.isConnected) {
      return {
        ok: true,
        confirmedByController: false,
        cmd: "DISARM",
        message: "Disarmed in software (controller disconnected).",
      };
    }
    return this.sendRawCommand("DISARM");
  }

  /**
   * Bounded single-motor test command (Channel 1 only unless FULL_PROPULSION is explicitly verified).
   * Enforces safe PWM limits and mandatory auto-shutoff duration.
   */
  public async commandSingleMotor(
    channel: number,
    pwm: number,
    durationMs: number
  ): Promise<CommandResult> {
    if (this.config.mode !== "REAL") {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "MOTOR",
        code: "SIMULATION_MODE_ACTIVE",
        message: "Physical motor command rejected: backend is in SIMULATION mode.",
      };
    }
    if (this._estopLatched) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "MOTOR",
        code: "ESTOP_ACTIVE",
        message: "Physical motor command rejected: Emergency Stop is active.",
      };
    }
    if (!this.isConnected || !this._armed) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "MOTOR",
        code: "NOT_ARMED",
        message: "Physical motor command rejected: controller must be connected and explicitly ARMED.",
      };
    }
    if (!Number.isInteger(channel) || channel < 1 || channel > 4) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "MOTOR",
        code: "INVALID_CHANNEL",
        message: "Motor channel must be an integer between 1 and 4.",
      };
    }
    if (channel > 1 && this.config.propulsion.allowedStage !== "FULL_PROPULSION") {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "MOTOR",
        code: "MULTI_MOTOR_UNCONFIRMED",
        message:
          "Only Channel 1 single-motor bench testing is enabled. Multi-motor control requires L298N_MODULE_COUNT >= 2 and THRUSTER_GEOMETRY_CONFIRMED=true.",
      };
    }
    if (!Number.isFinite(pwm) || !Number.isFinite(durationMs)) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "MOTOR",
        code: "INVALID_PARAMETERS",
        message: "Motor PWM and durationMs must be finite numbers.",
      };
    }

    const maxPwm = this.config.propulsion.maxSafeBenchPwm;
    if (Math.abs(pwm) > maxPwm) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "MOTOR",
        code: "PWM_LIMIT_EXCEEDED",
        message: `Requested |PWM| (${Math.abs(pwm)}) exceeds configured safe bench limit (${maxPwm}).`,
      };
    }

    const maxDur = this.config.propulsion.maxMotorDurationMs;
    if (durationMs < 100 || durationMs > maxDur) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "MOTOR",
        code: "DURATION_OUT_OF_RANGE",
        message: `Motor test durationMs (${durationMs}) must be between 100ms and ${maxDur}ms.`,
      };
    }

    return this.sendRawCommand("MOTOR", {
      ch: channel,
      pwm: Math.round(pwm),
      dur_ms: Math.round(durationMs),
    });
  }

  /**
   * Bounded single-servo angle command (Channel 1 only unless FULL_PROPULSION is explicitly verified).
   */
  public async commandSingleServo(
    channel: number,
    angleDeg: number
  ): Promise<CommandResult> {
    if (this.config.mode !== "REAL") {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "SERVO",
        code: "SIMULATION_MODE_ACTIVE",
        message: "Physical servo command rejected: backend is in SIMULATION mode.",
      };
    }
    if (this._estopLatched) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "SERVO",
        code: "ESTOP_ACTIVE",
        message: "Physical servo command rejected: Emergency Stop is active.",
      };
    }
    if (!this.isConnected || !this._armed) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "SERVO",
        code: "NOT_ARMED",
        message: "Physical servo command rejected: controller must be connected and explicitly ARMED.",
      };
    }
    if (!Number.isInteger(channel) || channel < 1 || channel > 4) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "SERVO",
        code: "INVALID_CHANNEL",
        message: "Servo channel must be an integer between 1 and 4.",
      };
    }
    if (channel > 1 && this.config.propulsion.allowedStage !== "FULL_PROPULSION") {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "SERVO",
        code: "MULTI_SERVO_UNCONFIRMED",
        message:
          "Only Channel 1 single-servo bench testing is enabled until THRUSTER_GEOMETRY_CONFIRMED=true.",
      };
    }

    const minDeg = this.config.propulsion.servoMinDeg;
    const maxDeg = this.config.propulsion.servoMaxDeg;
    if (!Number.isFinite(angleDeg) || angleDeg < minDeg || angleDeg > maxDeg) {
      return {
        ok: false,
        confirmedByController: false,
        cmd: "SERVO",
        code: "ANGLE_OUT_OF_RANGE",
        message: `Servo angle (${angleDeg}°) must be within safe mechanical bounds [${minDeg}°, ${maxDeg}°].`,
      };
    }

    return this.sendRawCommand("SERVO", {
      ch: channel,
      deg: Math.round(angleDeg),
    });
  }

  public async requestTelemetry(): Promise<CommandResult> {
    return this.sendRawCommand("TELEM");
  }

  public async ping(): Promise<CommandResult> {
    return this.sendRawCommand("PING");
  }

  // ==========================================================
  // SENSOR EVALUATION (TURBIDITY & IMU)
  // ==========================================================

  public evaluateTurbidity(nowMs: number = Date.now()): TurbidityReading {
    const turbCfg = this.config.sensors.turbidity;
    if (!turbCfg.installed) {
      return {
        state: "NOT_INSTALLED",
        rawAdc: null,
        voltage: null,
        calibrated: false,
        ntuEstimate: null,
        displayValue: "N/A",
        displayUnit: "NTU",
        cardStatus: "WARNING",
        error: "Turbidity sensor marked as not installed.",
        solution: "Set TURBIDITY_INSTALLED=true when wired to Arduino analog input.",
        timestampMs: null,
      };
    }

    if (!this.isConnected || !this._lastTelem) {
      return {
        state: "DISCONNECTED",
        rawAdc: null,
        voltage: null,
        calibrated: false,
        ntuEstimate: null,
        displayValue: "ERR",
        displayUnit: "NTU",
        cardStatus: "ERROR",
        error: "Master controller disconnected — no physical turbidity reading available.",
        solution: `Connect Arduino controller (${this.config.controller.serialPort || "configure SERIAL_PORT"}) and verify turbidity sensor on ${turbCfg.analogPin}.`,
        timestampMs: null,
      };
    }

    if (this.isTelemetryStale(nowMs)) {
      return {
        state: "STALE",
        rawAdc: this._lastTelem.turbRawAdc,
        voltage: null,
        calibrated: false,
        ntuEstimate: null,
        displayValue: "ERR",
        displayUnit: "NTU",
        cardStatus: "ERROR",
        error: `Turbidity telemetry is stale (> ${this.config.controller.telemetryStaleMs}ms old).`,
        solution: "Check USB serial connection and controller loop health.",
        timestampMs: this._lastTelem.receivedAtMs,
      };
    }

    const rawAdc = this._lastTelem.turbRawAdc;
    if (
      rawAdc === null ||
      rawAdc < turbCfg.minValidAdc ||
      rawAdc > turbCfg.maxValidAdc
    ) {
      return {
        state: "FAULT",
        rawAdc,
        voltage:
          rawAdc !== null
            ? parseFloat(((rawAdc / 1023.0) * turbCfg.vRefVolts).toFixed(3))
            : null,
        calibrated: false,
        ntuEstimate: null,
        displayValue: "ERR",
        displayUnit: "NTU",
        cardStatus: "ERROR",
        error:
          rawAdc === null
            ? "Turbidity ADC reading missing from controller frame."
            : `Turbidity ADC value (${rawAdc}) is at rail limit [${turbCfg.minValidAdc}..${turbCfg.maxValidAdc}], indicating open/shorted sensor wiring.`,
        solution: `Inspect 5V, GND, and analog signal wire on Arduino pin ${turbCfg.analogPin}.`,
        timestampMs: this._lastTelem.receivedAtMs,
      };
    }

    const voltage = parseFloat(((rawAdc / 1023.0) * turbCfg.vRefVolts).toFixed(3));

    if (
      turbCfg.calibrated &&
      turbCfg.calibrationSlope !== null &&
      turbCfg.calibrationOffset !== null
    ) {
      const computedNtu = parseFloat(
        Math.max(0, turbCfg.calibrationSlope * voltage + turbCfg.calibrationOffset).toFixed(1)
      );
      return {
        state: "CALIBRATED",
        rawAdc,
        voltage,
        calibrated: true,
        ntuEstimate: computedNtu,
        displayValue: computedNtu,
        displayUnit: "NTU",
        cardStatus: "OK",
        error: null,
        solution: null,
        timestampMs: this._lastTelem.receivedAtMs,
      };
    }

    // Uncalibrated: report honest raw ADC & voltage without inventing NTU calibration constants
    return {
      state: "UNCALIBRATED_RAW",
      rawAdc,
      voltage,
      calibrated: false,
      ntuEstimate: null,
      displayValue: `${rawAdc} (${voltage}V)`,
      displayUnit: "ADC raw",
      cardStatus: "WARNING",
      error: "Uncalibrated raw ADC reading — NTU reference calibration not yet applied.",
      solution:
        "Measure clear water and known NTU reference standards, then set TURBIDITY_CALIBRATED=true, TURBIDITY_CAL_SLOPE, and TURBIDITY_CAL_OFFSET.",
      timestampMs: this._lastTelem.receivedAtMs,
    };
  }

  public evaluateImu(nowMs: number = Date.now()): ImuReading {
    const yawNote =
      "MPU-6500 is a 6-axis IMU (3-axis accel + 3-axis gyro, WHO_AM_I=0x70 at 0x68). Without a magnetometer, gyro-integrated yaw drifts over time and is not an absolute compass heading.";

    if (!this.config.sensors.imu.installed) {
      return {
        state: "NOT_INSTALLED",
        imuOk: false,
        whoAmI: "0x00",
        rollDeg: null,
        pitchDeg: null,
        accelRaw: null,
        gyroRaw: null,
        yawNote,
        timestampMs: null,
      };
    }

    if (!this.isConnected || !this._lastTelem) {
      return {
        state: "DISCONNECTED",
        imuOk: false,
        whoAmI: "0x00",
        rollDeg: null,
        pitchDeg: null,
        accelRaw: null,
        gyroRaw: null,
        yawNote,
        timestampMs: null,
      };
    }

    if (this.isTelemetryStale(nowMs)) {
      return {
        state: "STALE",
        imuOk: false,
        whoAmI: this._lastTelem.whoAmI,
        rollDeg: null,
        pitchDeg: null,
        accelRaw: null,
        gyroRaw: null,
        yawNote,
        timestampMs: this._lastTelem.receivedAtMs,
      };
    }

    if (!this._lastTelem.imuOk || this._lastTelem.whoAmI !== "0x70") {
      return {
        state: "FAULT",
        imuOk: false,
        whoAmI: this._lastTelem.whoAmI,
        rollDeg: null,
        pitchDeg: null,
        accelRaw: null,
        gyroRaw: null,
        yawNote,
        timestampMs: this._lastTelem.receivedAtMs,
      };
    }

    return {
      state: "CALIBRATED",
      imuOk: true,
      whoAmI: this._lastTelem.whoAmI,
      rollDeg: this._lastTelem.rollDeg,
      pitchDeg: this._lastTelem.pitchDeg,
      accelRaw: this._lastTelem.accelRaw,
      gyroRaw: this._lastTelem.gyroRaw,
      yawNote,
      timestampMs: this._lastTelem.receivedAtMs,
    };
  }

  public async listAvailablePorts() {
    if (this.config.isCloudEnvironment) return [];
    return discoverSerialPorts();
  }
}
