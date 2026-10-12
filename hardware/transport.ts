import { EventEmitter } from "events";
import { execFile } from "child_process";
import { promisify } from "util";
import fsLib from "fs";

const execFileAsync = promisify(execFile);

export interface DiscoveredSerialPort {
  path: string;
  description?: string;
}

export interface SerialTransport {
  readonly isOpen: boolean;
  readonly portPath: string;
  open(): Promise<void>;
  close(): Promise<void>;
  writeLine(line: string): Promise<void>;
  onLine(listener: (line: string) => void): void;
  onClose(listener: (reason?: string) => void): void;
  onError(listener: (err: Error) => void): void;
  removeAllListeners(): void;
}

/**
 * Discover physically present serial ports on Windows (`COMx`) or Linux/macOS (`/dev/ttyACM*`, `/dev/ttyUSB*`).
 * Never invents ports that do not exist.
 */
export async function discoverSerialPorts(): Promise<DiscoveredSerialPort[]> {
  // First try optional `serialport` package if installed
  try {
    const spModuleName = "serialport";
    const sp: any = await import(/* @vite-ignore */ spModuleName);
    if (sp?.SerialPort?.list) {
      const list = await sp.SerialPort.list();
      return list.map((item: any) => ({
        path: item.path,
        description: item.friendlyName || item.manufacturer || "Serial Port",
      }));
    }
  } catch {
    // Fallback to OS-level port discovery below
  }

  if (process.platform === "win32") {
    try {
      const { stdout } = await execFileAsync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "[System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object { $_ }",
        ],
        { timeout: 3000 }
      );
      const lines = stdout
        .split(/[\r\n]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      return lines.map((path) => ({ path, description: "Windows COM Port" }));
    } catch {
      return [];
    }
  }

  // Linux / Raspberry Pi / macOS
  try {
    const devEntries = fsLib.readdirSync("/dev");
    const matching = devEntries.filter((name) =>
      /^(ttyACM\d+|ttyUSB\d+|cu\.usbmodem.*|cu\.usbserial.*)$/.test(name)
    );
    return matching.map((name) => ({
      path: `/dev/${name}`,
      description: "USB/ACM Serial Device",
    }));
  } catch {
    return [];
  }
}

/**
 * Mock / In-Memory Line-Oriented Serial Transport for deterministic unit and protocol testing
 * without physical hardware.
 */
export class MockSerialTransport implements SerialTransport {
  private emitter = new EventEmitter();
  private _isOpen = false;
  public readonly portPath: string;
  public writtenLines: string[] = [];
  private writeHandler?: (line: string, transport: MockSerialTransport) => void;
  private failOnOpenError?: Error;

  constructor(
    portPath: string = "MOCK://UNO_R3",
    options?: {
      onHostWrite?: (line: string, transport: MockSerialTransport) => void;
      failOnOpenError?: Error;
    }
  ) {
    this.portPath = portPath;
    this.writeHandler = options?.onHostWrite;
    this.failOnOpenError = options?.failOnOpenError;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  async open(): Promise<void> {
    if (this.failOnOpenError) {
      throw this.failOnOpenError;
    }
    this._isOpen = true;
  }

  async close(): Promise<void> {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.emitter.emit("close", "Transport closed");
  }

  async writeLine(line: string): Promise<void> {
    if (!this._isOpen) {
      throw new Error("Serial transport is not open");
    }
    const clean = line.endsWith("\n") ? line : `${line}\n`;
    this.writtenLines.push(clean);
    if (this.writeHandler) {
      this.writeHandler(clean, this);
    }
  }

  /** Inject a line as if received from the physical Arduino over USB serial */
  public receiveFromController(line: string): void {
    if (!this._isOpen) return;
    const clean = line.replace(/[\r\n]+$/, "");
    this.emitter.emit("line", clean);
  }

  /** Simulate an unexpected USB cable unplug / serial disconnect */
  public simulateDisconnect(reason: string = "USB cable disconnected"): void {
    if (!this._isOpen) return;
    this._isOpen = false;
    this.emitter.emit("close", reason);
  }

  /** Simulate a transport error */
  public simulateError(err: Error): void {
    this.emitter.emit("error", err);
  }

  onLine(listener: (line: string) => void): void {
    this.emitter.on("line", listener);
  }

  onClose(listener: (reason?: string) => void): void {
    this.emitter.on("close", listener);
  }

  onError(listener: (err: Error) => void): void {
    this.emitter.on("error", listener);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

/**
 * Physical OS Serial Transport.
 * Uses `serialport` package when available; otherwise fails honestly with actionable instructions
 * if the port cannot be opened cleanly.
 */
export class PhysicalSerialTransport implements SerialTransport {
  private emitter = new EventEmitter();
  private _isOpen = false;
  public readonly portPath: string;
  public readonly baudRate: number;
  private spInstance: any = null;
  private rxBuffer = "";

  constructor(portPath: string, baudRate: number = 115200) {
    this.portPath = portPath;
    this.baudRate = baudRate;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  async open(): Promise<void> {
    if (!this.portPath) {
      throw new Error("SERIAL_PORT is not configured. Set SERIAL_PORT in .env (e.g. COM3 or /dev/ttyACM0).");
    }

    let SerialPortClass: any = null;
    try {
      const spModuleName = "serialport";
      const spMod: any = await import(/* @vite-ignore */ spModuleName);
      SerialPortClass = spMod.SerialPort || spMod.default?.SerialPort;
    } catch {
      const discovered = await discoverSerialPorts();
      const portExists = discovered.some(
        (p) => p.path.toLowerCase() === this.portPath.toLowerCase()
      );
      if (!portExists) {
        throw new Error(
          `Serial port '${this.portPath}' is not present on this host (detected ports: ${
            discovered.length > 0 ? discovered.map((d) => d.path).join(", ") : "none"
          }).`
        );
      }
      throw new Error(
        `Serial port '${this.portPath}' was detected, but the 'serialport' Node driver is not installed. Run 'npm install serialport' on the host with the Arduino attached.`
      );
    }

    await new Promise<void>((resolve, reject) => {
      const port = new SerialPortClass({
        path: this.portPath,
        baudRate: this.baudRate,
        autoOpen: false,
      });

      port.on("data", (chunk: Buffer) => {
        this.rxBuffer += chunk.toString("utf8");
        if (this.rxBuffer.length > 4096) {
          // Bound input buffer to prevent memory exhaustion on noisy serial line
          this.rxBuffer = this.rxBuffer.slice(-1024);
        }
        let nlIdx: number;
        while ((nlIdx = this.rxBuffer.indexOf("\n")) >= 0) {
          const line = this.rxBuffer.slice(0, nlIdx).replace(/\r$/, "");
          this.rxBuffer = this.rxBuffer.slice(nlIdx + 1);
          if (line.trim()) {
            this.emitter.emit("line", line);
          }
        }
      });

      port.on("close", () => {
        const wasOpen = this._isOpen;
        this._isOpen = false;
        if (wasOpen) {
          this.emitter.emit("close", "Serial port closed");
        }
      });

      port.on("error", (err: Error) => {
        this.emitter.emit("error", err);
      });

      port.open((err: Error | null) => {
        if (err) {
          reject(new Error(`Failed to open serial port '${this.portPath}' at ${this.baudRate} baud: ${err.message}`));
          return;
        }
        this.spInstance = port;
        this._isOpen = true;
        resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (!this._isOpen || !this.spInstance) {
      this._isOpen = false;
      return;
    }
    await new Promise<void>((resolve) => {
      this.spInstance.close(() => {
        this._isOpen = false;
        this.spInstance = null;
        resolve();
      });
    });
  }

  async writeLine(line: string): Promise<void> {
    if (!this._isOpen || !this.spInstance) {
      throw new Error("Serial port is not open");
    }
    const payload = line.endsWith("\n") ? line : `${line}\n`;
    await new Promise<void>((resolve, reject) => {
      this.spInstance.write(payload, "utf8", (err: Error | null) => {
        if (err) return reject(err);
        this.spInstance.drain((drainErr: Error | null) => {
          if (drainErr) return reject(drainErr);
          resolve();
        });
      });
    });
  }

  onLine(listener: (line: string) => void): void {
    this.emitter.on("line", listener);
  }

  onClose(listener: (reason?: string) => void): void {
    this.emitter.on("close", listener);
  }

  onError(listener: (err: Error) => void): void {
    this.emitter.on("error", listener);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}
