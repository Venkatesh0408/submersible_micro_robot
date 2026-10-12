export const PROTOCOL_VERSION = "VSTY/1";
export const MAX_LINE_LENGTH = 256;

export type ControllerFrameType = "HELLO" | "ACK" | "ERR" | "TELEM" | "EVENT";

export interface ParsedHelloFrame {
  type: "HELLO";
  board: string;
  fw: string;
  imuWhoAmI: string;
  watchdogMs: number;
  raw: Record<string, string>;
}

export interface ParsedAckFrame {
  type: "ACK";
  seq: number;
  cmd: string;
  fields: Record<string, string>;
}

export interface ParsedErrFrame {
  type: "ERR";
  seq: number;
  cmd: string;
  code: string;
  msg: string;
  fields: Record<string, string>;
}

export interface ParsedTelemFrame {
  type: "TELEM";
  receivedAtMs: number;
  uptimeMs: number;
  armed: boolean;
  estop: boolean;
  turbRawAdc: number | null;
  imuOk: boolean;
  whoAmI: string;
  accelRaw: { ax: number; ay: number; az: number } | null;
  gyroRaw: { gx: number; gy: number; gz: number } | null;
  rollDeg: number | null;
  pitchDeg: number | null;
  motor1Pwm: number;
  servo1Deg: number;
  raw: Record<string, string>;
}

export interface ParsedEventFrame {
  type: "EVENT";
  eventType: string;
  msg: string;
  fields: Record<string, string>;
}

export type ParsedControllerFrame =
  | ParsedHelloFrame
  | ParsedAckFrame
  | ParsedErrFrame
  | ParsedTelemFrame
  | ParsedEventFrame;

export interface ParseResult {
  ok: boolean;
  frame?: ParsedControllerFrame;
  error?: string;
}

function parseKeyValueTokens(tokens: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const token of tokens) {
    const eqIdx = token.indexOf("=");
    if (eqIdx > 0) {
      const key = token.slice(0, eqIdx).trim();
      const val = token.slice(eqIdx + 1).trim();
      if (key) {
        map[key] = val;
      }
    }
  }
  return map;
}

function parseStrictInt(val: string | undefined): number | null {
  if (val === undefined || !/^-?\d+$/.test(val.trim())) return null;
  const n = parseInt(val.trim(), 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function parseControllerLine(line: string, nowMs: number = Date.now()): ParseResult {
  const trimmed = line.replace(/[\r\n]+$/, "").trim();
  if (!trimmed) {
    return { ok: false, error: "Empty protocol line" };
  }
  if (trimmed.length > MAX_LINE_LENGTH) {
    return { ok: false, error: `Line exceeds maximum length (${MAX_LINE_LENGTH})` };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) {
    return { ok: false, error: "Malformed frame: insufficient tokens" };
  }

  const [prefix, frameTypeRaw, ...rest] = parts;
  if (prefix !== PROTOCOL_VERSION) {
    return { ok: false, error: `Unsupported protocol prefix '${prefix}' (expected '${PROTOCOL_VERSION}')` };
  }

  const kv = parseKeyValueTokens(rest);

  switch (frameTypeRaw) {
    case "HELLO": {
      const board = kv.board || "UNKNOWN";
      const fw = kv.fw || "0.0.0";
      const imuWhoAmI = (kv.imu || kv.who_am_i || "0x00").toLowerCase();
      const watchdogMs = parseStrictInt(kv.watchdog_ms) ?? 2000;
      return {
        ok: true,
        frame: {
          type: "HELLO",
          board,
          fw,
          imuWhoAmI,
          watchdogMs,
          raw: kv,
        },
      };
    }

    case "ACK": {
      const seq = parseStrictInt(kv.seq);
      const cmd = kv.cmd || "";
      if (seq === null || seq < 0 || !cmd) {
        return { ok: false, error: "Malformed ACK frame: missing valid seq or cmd" };
      }
      return {
        ok: true,
        frame: {
          type: "ACK",
          seq,
          cmd,
          fields: kv,
        },
      };
    }

    case "ERR": {
      const seq = parseStrictInt(kv.seq) ?? -1;
      const cmd = kv.cmd || "UNKNOWN";
      const code = kv.code || "CONTROLLER_ERROR";
      const msg = (kv.msg || code).replace(/_/g, " ");
      return {
        ok: true,
        frame: {
          type: "ERR",
          seq,
          cmd,
          code,
          msg,
          fields: kv,
        },
      };
    }

    case "TELEM": {
      const uptimeMs = parseStrictInt(kv.uptime_ms);
      if (uptimeMs === null || uptimeMs < 0) {
        return { ok: false, error: "Malformed TELEM frame: invalid uptime_ms" };
      }
      const armed = kv.armed === "1";
      const estop = kv.estop === "1";

      const rawTurb = parseStrictInt(kv.turb_raw);
      let turbRawAdc: number | null = null;
      if (rawTurb !== null && rawTurb >= 0 && rawTurb <= 1023) {
        turbRawAdc = rawTurb;
      } else if (rawTurb !== null && (rawTurb < -1 || rawTurb > 1023)) {
        return { ok: false, error: `Implausible turb_raw ADC value: ${rawTurb}` };
      }

      const whoAmI = (kv.who_am_i || "0x00").toLowerCase();
      const imuOk = kv.imu_ok === "1" && whoAmI === "0x70";

      const ax = parseStrictInt(kv.ax);
      const ay = parseStrictInt(kv.ay);
      const az = parseStrictInt(kv.az);
      const gx = parseStrictInt(kv.gx);
      const gy = parseStrictInt(kv.gy);
      const gz = parseStrictInt(kv.gz);
      const rollDeci = parseStrictInt(kv.roll);
      const pitchDeci = parseStrictInt(kv.pitch);

      const accelRaw =
        imuOk && ax !== null && ay !== null && az !== null ? { ax, ay, az } : null;
      const gyroRaw =
        imuOk && gx !== null && gy !== null && gz !== null ? { gx, gy, gz } : null;

      let rollDeg: number | null = null;
      let pitchDeg: number | null = null;
      if (imuOk && rollDeci !== null && pitchDeci !== null) {
        const r = rollDeci / 10.0;
        const p = pitchDeci / 10.0;
        if (Math.abs(r) <= 180 && Math.abs(p) <= 180) {
          rollDeg = r;
          pitchDeg = p;
        }
      }

      const motor1Pwm = parseStrictInt(kv.m1) ?? 0;
      const servo1Deg = parseStrictInt(kv.s1) ?? 90;

      return {
        ok: true,
        frame: {
          type: "TELEM",
          receivedAtMs: nowMs,
          uptimeMs,
          armed,
          estop,
          turbRawAdc,
          imuOk,
          whoAmI,
          accelRaw,
          gyroRaw,
          rollDeg,
          pitchDeg,
          motor1Pwm,
          servo1Deg,
          raw: kv,
        },
      };
    }

    case "EVENT": {
      const eventType = kv.type || "INFO";
      const msg = (kv.msg || eventType).replace(/_/g, " ");
      return {
        ok: true,
        frame: {
          type: "EVENT",
          eventType,
          msg,
          fields: kv,
        },
      };
    }

    default:
      return { ok: false, error: `Unknown frame type '${frameTypeRaw}'` };
  }
}

export function formatHostCommand(
  seq: number,
  cmd: string,
  params?: Record<string, string | number>
): string {
  if (!Number.isInteger(seq) || seq < 0) {
    throw new Error(`Invalid sequence number: ${seq}`);
  }
  const cleanCmd = cmd.trim().toUpperCase();
  if (!cleanCmd || /\s/.test(cleanCmd)) {
    throw new Error(`Invalid command verb: '${cmd}'`);
  }
  const paramTokens: string[] = [];
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      const safeKey = k.trim();
      const safeVal = String(v).trim().replace(/\s+/g, "_");
      paramTokens.push(`${safeKey}=${safeVal}`);
    }
  }
  const suffix = paramTokens.length > 0 ? " " + paramTokens.join(" ") : "";
  return `${PROTOCOL_VERSION} seq=${seq} ${cleanCmd}${suffix}\n`;
}
