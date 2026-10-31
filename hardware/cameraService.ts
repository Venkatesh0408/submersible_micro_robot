import http from "http";
import https from "https";
import fsLib from "fs";
import path from "path";
import { HardwareConfig } from "./config.js";
import { logger } from "../logger.js";

export interface CamUrlValidation {
  ok: boolean;
  reason?: string;
  parsedUrl?: URL;
}

export interface CameraPingStatus {
  online: boolean;
  verifiedAtMs: number | null;
  targetUrl: string | null;
  statusCode?: number;
  contentType?: string;
  latencyMs?: number;
  message: string;
  isVerified?: boolean;
  failureCount?: number;
  streamReachable?: boolean;
  isCloudEnvironment?: boolean;
}

export interface BackendCameraConfig {
  ip: string;
  fallbackIp: string;
  streamPort: number;
  capturePort: number;
  streamPath: string;
  capturePath: string;
  streamUrl: string;
  captureUrl: string;
  proxyStreamUrl: string;
  isVerified: boolean;
  isCloudEnvironment: boolean;
  autoConnect: boolean;
}

export interface SnapshotCaptureResult {
  success: boolean;
  simulated: boolean;
  message: string;
  file?: {
    filename: string;
    url: string;
    sizeBytes?: number;
  };
}

const JPEG_SOI = Buffer.from([0xff, 0xd8]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
const MAX_SNAPSHOT_BYTES = 5 * 1024 * 1024; // 5 MB safety bound

/**
 * SSRF guard: the ESP32-CAM is always a device on the local private network.
 * Only allow private RFC1918 LAN addresses, loopback, or *.local mDNS names.
 */
export function validateCamUrl(raw: string, opts?: { allowLoopback?: boolean }): CamUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http/https is allowed" };
  }
  if (url.port) {
    const portNum = Number(url.port);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      return { ok: false, reason: "Invalid port number" };
    }
  }
  const host = url.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "0.0.0.0" ||
    host.startsWith("127.")
  ) {
    if (opts?.allowLoopback || process.env.ALLOW_TEST_LOOPBACK === "true") {
      return { ok: true, parsedUrl: url };
    }
    return { ok: false, reason: "Loopback addresses are not permitted" };
  }
  // Reject cloud metadata / link-local addresses
  if (host === "169.254.169.254" || host.startsWith("169.254.")) {
    return { ok: false, reason: "Cloud metadata and link-local addresses are not permitted" };
  }
  if (host.endsWith(".local")) {
    if (host.includes("localhost") || host.includes("127.") || host.includes("169.254.")) {
      return { ok: false, reason: "Disallowed local name" };
    }
    return { ok: true, parsedUrl: url };
  }
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) {
    return { ok: false, reason: "Camera address must be a private LAN IP or a .local name" };
  }
  if (m.slice(1).some((o) => Number(o) > 255)) {
    return { ok: false, reason: "Invalid IP address" };
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  const c = Number(m[3]);
  if (a >= 224) {
    return { ok: false, reason: "Multicast and reserved addresses are not permitted" };
  }
  const isPrivate =
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 100 && b >= 64 && b <= 127);
  if (!isPrivate) {
    return {
      ok: false,
      reason: "Only private LAN addresses (10.x, 172.16–31.x, 192.168.x) are allowed",
    };
  }
  return { ok: true, parsedUrl: url };
}

/**
 * Validate that a buffer represents a structurally valid JPEG image.
 * A real JPEG starts with 0xFF, 0xD8 (SOI), ends with 0xFF, 0xD9 (EOI),
 * and contains valid markers including a Start of Frame (SOF)
 * with non-zero dimensions and a Start of Scan (SOS 0xFFDA).
 */
export function isValidJpeg(buffer: Buffer): boolean {
  if (!buffer || buffer.length < 64) return false;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return false;
  if (buffer[buffer.length - 2] !== 0xff || buffer[buffer.length - 1] !== 0xd9) return false;

  let offset = 2;
  let hasSof = false;
  let hasSos = false;

  while (offset < buffer.length - 1) {
    if (buffer[offset] !== 0xff) {
      offset++;
      continue;
    }

    while (offset < buffer.length && buffer[offset] === 0xff) {
      offset++;
    }
    if (offset >= buffer.length) break;

    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (marker === 0xd9) break;
      continue;
    }

    if (marker === 0xda) {
      hasSos = true;
      break;
    }

    if (offset + 2 > buffer.length) break;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) {
      return false;
    }

    const isSof =
      marker === 0xc0 ||
      marker === 0xc1 ||
      marker === 0xc2 ||
      marker === 0xc3 ||
      marker === 0xc5 ||
      marker === 0xc6 ||
      marker === 0xc7 ||
      marker === 0xc9 ||
      marker === 0xca ||
      marker === 0xcb ||
      marker === 0xcd ||
      marker === 0xce ||
      marker === 0xcf;

    if (isSof) {
      if (length >= 7) {
        const height = buffer.readUInt16BE(offset + 3);
        const width = buffer.readUInt16BE(offset + 5);
        if (width > 0 && height > 0) {
          hasSof = true;
        }
      }
    }

    offset += length;
  }

  return hasSof && hasSos;
}

/**
 * Extract the first complete JPEG image (SOI 0xFFD8 .. EOI 0xFFD9) from a buffer
 * that may be either a single JPEG or a multipart/x-mixed-replace MJPEG stream chunk sequence.
 * Verifies that the candidate frame contains valid JPEG structure.
 */
export function extractFirstJpegFrame(buffer: Buffer): Buffer | null {
  let searchStart = 0;
  while (searchStart < buffer.length - 1) {
    const soiIdx = buffer.indexOf(JPEG_SOI, searchStart);
    if (soiIdx < 0) return null;
    const eoiIdx = buffer.indexOf(JPEG_EOI, soiIdx + 2);
    if (eoiIdx < 0) return null;

    const candidate = buffer.subarray(soiIdx, eoiIdx + 2);
    if (candidate.length >= 8 && candidate[0] === 0xff && candidate[1] === 0xd8 && candidate[candidate.length - 2] === 0xff && candidate[candidate.length - 1] === 0xd9) {
      return candidate;
    }
    searchStart = soiIdx + 2;
  }
  return null;
}

export class Esp32CameraService {
  private config: HardwareConfig;
  private autoConnectTimer: NodeJS.Timeout | null = null;
  private isCheckingConnection = false;
  private consecutiveFailures = 0;
  private listeners: Array<(status: CameraPingStatus) => void> = [];

  private lastStatus: CameraPingStatus = {
    online: false,
    verifiedAtMs: null,
    targetUrl: null,
    message: "ESP32-CAM has not been verified yet.",
    isVerified: false,
    failureCount: 0,
    streamReachable: false,
    isCloudEnvironment: false,
  };

  constructor(config: HardwareConfig) {
    this.config = config;
    this.lastStatus.isVerified = config.camera.isVerified;
    this.lastStatus.isCloudEnvironment = config.isCloudEnvironment;
  }

  public updateConfig(config: HardwareConfig): void {
    this.config = config;
    this.lastStatus.isVerified = config.camera.isVerified;
    this.lastStatus.isCloudEnvironment = config.isCloudEnvironment;
  }

  public get status(): CameraPingStatus {
    return { ...this.lastStatus };
  }

  public onStatusChange(listener: (status: CameraPingStatus) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private notifyListeners(): void {
    const copy = this.status;
    for (const l of this.listeners) {
      try {
        l(copy);
      } catch (err) {
        logger.error("[camera] Error in status listener:", err);
      }
    }
  }

  public getCameraConfig(): BackendCameraConfig {
    const streamUrl = this.getDefaultStreamUrl();
    const captureUrl = this.getDefaultCaptureUrl();
    return {
      ip: this.config.camera.defaultIp,
      fallbackIp: this.config.camera.fallbackIp,
      streamPort: this.config.camera.defaultStreamPort,
      capturePort: this.config.camera.defaultCapturePort,
      streamPath: this.config.camera.defaultStreamPath,
      capturePath: this.config.camera.defaultCapturePath,
      streamUrl,
      captureUrl,
      proxyStreamUrl: "/api/camera/stream",
      isVerified: this.config.camera.isVerified,
      isCloudEnvironment: this.config.isCloudEnvironment,
      autoConnect: this.config.camera.autoConnect,
    };
  }

  public updateRuntimeCameraConfig(opts: {
    ip?: string;
    streamPort?: number;
    capturePort?: number;
    streamPath?: string;
    capturePath?: string;
    isVerified?: boolean;
  }): { config: BackendCameraConfig; status: CameraPingStatus } {
    if (opts.ip && opts.ip.trim()) {
      this.config.camera.defaultIp = opts.ip.trim();
    }
    if (opts.streamPort && Number.isSafeInteger(opts.streamPort)) {
      this.config.camera.defaultStreamPort = opts.streamPort;
    }
    if (opts.capturePort && Number.isSafeInteger(opts.capturePort)) {
      this.config.camera.defaultCapturePort = opts.capturePort;
    }
    if (opts.streamPath && opts.streamPath.trim()) {
      this.config.camera.defaultStreamPath = opts.streamPath.trim();
    }
    if (opts.capturePath && opts.capturePath.trim()) {
      this.config.camera.defaultCapturePath = opts.capturePath.trim();
    }
    if (typeof opts.isVerified === "boolean") {
      this.config.camera.isVerified = opts.isVerified;
    } else {
      this.config.camera.isVerified = true;
    }
    this.lastStatus.isVerified = this.config.camera.isVerified;
    this.consecutiveFailures = 0;

    // Trigger an immediate check asynchronously
    this.checkReachability().catch(() => {});

    return {
      config: this.getCameraConfig(),
      status: this.status,
    };
  }

  public getDefaultStreamUrl(): string {
    if (this.config.camera.streamUrl) {
      return this.config.camera.streamUrl;
    }
    const { defaultIp, defaultStreamPort, defaultStreamPath } = this.config.camera;
    const p = defaultStreamPath.startsWith("/") ? defaultStreamPath : `/${defaultStreamPath}`;
    return `http://${defaultIp}:${defaultStreamPort}${p}`;
  }

  public getDefaultCaptureUrl(): string {
    if (this.config.camera.snapshotUrl) {
      return this.config.camera.snapshotUrl;
    }
    if (this.config.camera.streamUrl) {
      try {
        const u = new URL(this.config.camera.streamUrl);
        const p = this.config.camera.defaultCapturePath.startsWith("/")
          ? this.config.camera.defaultCapturePath
          : `/${this.config.camera.defaultCapturePath}`;
        const port = this.config.camera.defaultCapturePort || (u.port ? Number(u.port) : 80);
        return `${u.protocol}//${u.hostname}:${port}${p}`;
      } catch {}
    }
    const { defaultIp, defaultCapturePort, defaultCapturePath } = this.config.camera;
    const p = defaultCapturePath.startsWith("/") ? defaultCapturePath : `/${defaultCapturePath}`;
    return `http://${defaultIp}:${defaultCapturePort}${p}`;
  }

  public getFallbackStreamUrl(): string | null {
    if (!this.config.camera.fallbackIp) return null;
    const { fallbackIp, defaultStreamPort, defaultStreamPath } = this.config.camera;
    const p = defaultStreamPath.startsWith("/") ? defaultStreamPath : `/${defaultStreamPath}`;
    return `http://${fallbackIp}:${defaultStreamPort}${p}`;
  }

  /**
   * Background connection manager running flag.
   */
  private autoConnectRunning = false;

  public startAutoConnect(): void {
    if (this.autoConnectRunning) return;
    if (!this.config.camera.autoConnect) {
      logger.info("[camera] Camera auto-connect is disabled by configuration");
      return;
    }
    this.autoConnectRunning = true;

    const scheduleNext = () => {
      if (!this.autoConnectRunning) return;
      const delayMs = this.lastStatus.online
        ? 10000 // steady check every 10 seconds when healthy
        : Math.min(
            15000,
            Math.max(2000, 2000 * Math.pow(1.4, Math.min(this.consecutiveFailures, 6)))
          );

      this.autoConnectTimer = setTimeout(async () => {
        if (!this.autoConnectRunning) return;
        try {
          await this.checkReachability();
        } catch (err) {
          logger.error("[camera] Auto-connect check error:", err);
        } finally {
          scheduleNext();
        }
      }, delayMs);

      if (this.autoConnectTimer && typeof this.autoConnectTimer.unref === "function") {
        this.autoConnectTimer.unref();
      }
    };

    // Run first check right away non-blockingly
    this.checkReachability().catch((err) => {
      logger.warn("[camera] Initial camera reachability check notice:", err?.message || err);
    }).finally(() => {
      scheduleNext();
    });
  }

  public stopAutoConnect(): void {
    this.autoConnectRunning = false;
    if (this.autoConnectTimer) {
      clearTimeout(this.autoConnectTimer);
      this.autoConnectTimer = null;
    }
  }

  public async checkConnection(): Promise<CameraPingStatus> {
    return this.checkReachability();
  }

  /**
   * Periodic check called by autoConnect or manually.
   */
  public async checkReachability(): Promise<CameraPingStatus> {
    if (this.isCheckingConnection) return this.lastStatus;
    this.isCheckingConnection = true;

    try {
      const primaryUrl = this.getDefaultStreamUrl();
      let res = await this.pingCamera(primaryUrl);

      // If primary failed but a fallback is configured, test fallback
      if (!res.online && this.getFallbackStreamUrl()) {
        const fallbackUrl = this.getFallbackStreamUrl()!;
        const fallbackRes = await this.pingCamera(fallbackUrl);
        if (fallbackRes.online) {
          res = {
            ...fallbackRes,
            message: "ESP32-CAM connected via fallback address.",
          };
        }
      }

      if (res.online) {
        this.consecutiveFailures = 0;
        this.lastStatus = {
          ...res,
          isVerified: this.config.camera.isVerified,
          failureCount: 0,
          streamReachable: true,
          isCloudEnvironment: this.config.isCloudEnvironment,
        };
      } else {
        this.consecutiveFailures++;
        let honestMessage = res.message;
        if (!this.config.camera.isVerified) {
          honestMessage = "ESP32-CAM address is unconfirmed. Check your router DHCP reservation or Serial Monitor output to verify the camera IP.";
        }
        this.lastStatus = {
          ...res,
          message: honestMessage,
          isVerified: this.config.camera.isVerified,
          failureCount: this.consecutiveFailures,
          streamReachable: false,
          isCloudEnvironment: this.config.isCloudEnvironment,
        };
      }

      this.notifyListeners();
      return this.lastStatus;
    } finally {
      this.isCheckingConnection = false;
    }
  }

  /**
   * Verify reachability of an ESP32-CAM URL on the local LAN.
   * Never reports online unless an HTTP 2xx response is actually received within timeout.
   */
  public async pingCamera(targetUrl: string): Promise<CameraPingStatus> {
    if (this.config.isCloudEnvironment) {
      const status: CameraPingStatus = {
        online: false,
        verifiedAtMs: Date.now(),
        targetUrl: null,
        message:
          "Cloud-hosted backend cannot reach a private LAN ESP32-CAM address. Run the backend locally on the same Wi-Fi LAN as the ESP32-CAM.",
        isCloudEnvironment: true,
      };
      this.lastStatus = status;
      return status;
    }

    const guard = validateCamUrl(targetUrl);
    if (!guard.ok) {
      return {
        online: false,
        verifiedAtMs: Date.now(),
        targetUrl: null,
        message: guard.reason || "Invalid camera URL",
        isCloudEnvironment: false,
      };
    }

    const startTime = Date.now();
    const timeoutMs = this.config.camera.pingTimeoutMs;

    return new Promise<CameraPingStatus>((resolve) => {
      let settled = false;
      const finish = (res: CameraPingStatus) => {
        if (settled) return;
        settled = true;
        this.lastStatus = {
          ...res,
          isVerified: this.config.camera.isVerified,
          isCloudEnvironment: this.config.isCloudEnvironment,
        };
        resolve(this.lastStatus);
      };

      try {
        const protocol = targetUrl.startsWith("https") ? https : http;
        const req = protocol.get(targetUrl, { timeout: timeoutMs }, (res) => {
          const latencyMs = Date.now() - startTime;
          const statusCode = res.statusCode || 0;
          const contentType = res.headers["content-type"] || "video/mjpeg";
          res.destroy();

          if (statusCode >= 300 && statusCode < 400) {
            finish({
              online: false,
              verifiedAtMs: Date.now(),
              targetUrl,
              statusCode,
              contentType,
              latencyMs,
              message: "ESP32-CAM stream does not permit redirects.",
            });
          } else if (statusCode >= 200 && statusCode < 300) {
            const isExpectedType =
              contentType.toLowerCase().includes("multipart") ||
              contentType.toLowerCase().includes("image") ||
              contentType.toLowerCase().includes("octet-stream");
            if (!isExpectedType) {
              finish({
                online: false,
                verifiedAtMs: Date.now(),
                targetUrl,
                statusCode,
                contentType,
                latencyMs,
                message: `ESP32-CAM returned unexpected content type: ${contentType}`,
              });
            } else {
              finish({
                online: true,
                verifiedAtMs: Date.now(),
                targetUrl,
                statusCode,
                contentType,
                latencyMs,
                message: `ESP32-CAM connected over WiFi (${latencyMs}ms)`,
              });
            }
          } else {
            finish({
              online: false,
              verifiedAtMs: Date.now(),
              targetUrl,
              statusCode,
              contentType,
              latencyMs,
              message: `ESP32-CAM responded with HTTP ${statusCode}`,
            });
          }
        });

        req.on("error", () => {
          finish({
            online: false,
            verifiedAtMs: Date.now(),
            targetUrl,
            message: "Could not reach ESP32-CAM over WiFi.",
          });
        });

        req.on("timeout", () => {
          req.destroy();
          finish({
            online: false,
            verifiedAtMs: Date.now(),
            targetUrl,
            message: `Timeout connecting to ESP32-CAM (${timeoutMs}ms)`,
          });
        });
      } catch (err: any) {
        finish({
          online: false,
          verifiedAtMs: Date.now(),
          targetUrl,
          message: err?.message || "Failed to reach ESP32-CAM",
        });
      }
    });
  }

  /**
   * Proxy the live camera stream from targetUrl to client response.
   * Handles timeouts, status codes, original content-type / multipart boundary,
   * client disconnect cleanup, and bounded resource use.
   */
  public proxyStream(
    targetUrl: string,
    clientReq: http.IncomingMessage,
    clientRes: http.ServerResponse
  ): void {
    if (this.config.isCloudEnvironment) {
      if (!clientRes.headersSent) {
        clientRes.writeHead(503, { "Content-Type": "text/plain" });
        clientRes.end(
          "Cloud backend cannot proxy a private LAN ESP32-CAM stream. Run locally on the robot's LAN."
        );
      }
      return;
    }

    const guard = validateCamUrl(targetUrl);
    if (!guard.ok) {
      if (!clientRes.headersSent) {
        clientRes.writeHead(400, { "Content-Type": "text/plain" });
        clientRes.end(guard.reason || "Invalid camera URL");
      }
      return;
    }

    try {
      const protocol = targetUrl.startsWith("https") ? https : http;
      const proxyReq = protocol.get(
        targetUrl,
        { timeout: this.config.camera.pingTimeoutMs * 2 },
        (proxyRes) => {
          const statusCode = proxyRes.statusCode || 200;
          if (statusCode >= 300 && statusCode < 400) {
            proxyRes.destroy();
            if (!clientRes.headersSent) {
              clientRes.writeHead(502, { "Content-Type": "text/plain" });
              clientRes.end("ESP32-CAM stream does not permit redirects.");
            }
            return;
          }
          if (statusCode < 200 || statusCode >= 300) {
            proxyRes.destroy();
            if (!clientRes.headersSent) {
              clientRes.writeHead(statusCode, { "Content-Type": "text/plain" });
              clientRes.end(`ESP32-CAM stream returned HTTP ${statusCode}`);
            }
            return;
          }

          const rawContentType = proxyRes.headers["content-type"];
          const contentType =
            rawContentType && rawContentType.toLowerCase().includes("multipart")
              ? rawContentType
              : "multipart/x-mixed-replace; boundary=frame";

          if (!clientRes.headersSent) {
            clientRes.writeHead(200, {
              "Content-Type": contentType,
              "Cache-Control": "no-cache, no-store, must-revalidate",
              "Pragma": "no-cache",
              "Connection": "keep-alive",
              "X-Accel-Buffering": "no",
            });
          }

          proxyRes.pipe(clientRes);

          // Stream cleanup on client disconnect or response finish
          const cleanup = () => {
            if (!proxyRes.destroyed) proxyRes.destroy();
            if (!proxyReq.destroyed) proxyReq.destroy();
          };
          clientReq.on("close", cleanup);
          clientRes.on("close", cleanup);
          clientRes.on("finish", cleanup);

          proxyRes.on("error", (err) => {
            logger.error("[camera] Proxy response error:", err?.message || err);
            cleanup();
            if (!clientRes.destroyed) clientRes.destroy();
          });
        }
      );

      proxyReq.on("error", (err) => {
        logger.error("[camera] Stream proxy connection error:", err?.message || err);
        if (!clientRes.headersSent) {
          clientRes.writeHead(502, { "Content-Type": "text/plain" });
          clientRes.end("ESP32-CAM Stream Proxy Error: Camera stream is unreachable.");
        }
      });

      proxyReq.on("timeout", () => {
        proxyReq.destroy();
        if (!clientRes.headersSent) {
          clientRes.writeHead(504, { "Content-Type": "text/plain" });
          clientRes.end("ESP32-CAM Stream Timeout");
        }
      });

      clientReq.on("close", () => {
        if (!proxyReq.destroyed) proxyReq.destroy();
      });
    } catch (err: any) {
      if (!clientRes.headersSent) {
        clientRes.writeHead(500, { "Content-Type": "text/plain" });
        clientRes.end("Failed to proxy camera stream.");
      }
    }
  }

  /**
   * Capture a single validated JPEG frame from the ESP32-CAM.
   * Prefers the still `/capture` endpoint if available, falling back to `/stream` MJPEG extraction.
   * Validates the resulting image has JPEG SOI (0xFFD8) and EOI (0xFFD9).
   */
  public async captureSnapshotToFile(
    targetUrl?: string,
    mediaDir: string = path.join(process.cwd(), "public", "media"),
    requestedFilename?: string
  ): Promise<SnapshotCaptureResult> {
    if (this.config.isCloudEnvironment) {
      return {
        success: false,
        simulated: false,
        message:
          "Cannot capture from a private LAN ESP32-CAM on a cloud-hosted backend. Run the backend locally on the robot's Wi-Fi network.",
      };
    }

    const captureEndpoint = targetUrl && targetUrl.trim()
      ? targetUrl.trim()
      : this.getDefaultCaptureUrl();

    const guard = validateCamUrl(captureEndpoint);
    if (!guard.ok) {
      return {
        success: false,
        simulated: false,
        message: guard.reason || "Invalid camera URL",
      };
    }

    const safeName = requestedFilename
      ? path.basename(requestedFilename).replace(/[^a-zA-Z0-9_.-]/g, "_")
      : `esp-snapshot-${Date.now()}.jpg`;

    if (!fsLib.existsSync(mediaDir)) {
      fsLib.mkdirSync(mediaDir, { recursive: true });
    }
    const targetPath = path.join(mediaDir, safeName);
    const timeoutMs = this.config.camera.snapshotTimeoutMs;

    // Helper to attempt fetch from an endpoint
    const tryFetchFrame = (url: string): Promise<Buffer | null> => {
      return new Promise<Buffer | null>((resolve) => {
        try {
          const protocol = url.startsWith("https") ? https : http;
          const req = protocol.get(url, { timeout: timeoutMs }, (streamRes) => {
            const statusCode = streamRes.statusCode || 0;
            if (statusCode < 200 || statusCode >= 300) {
              streamRes.destroy();
              return resolve(null);
            }

            const chunks: Buffer[] = [];
            let totalBytes = 0;

            streamRes.on("data", (chunk: Buffer) => {
              chunks.push(chunk);
              totalBytes += chunk.length;

              const combined = Buffer.concat(chunks, totalBytes);
              const jpegFrame = extractFirstJpegFrame(combined);
              if (jpegFrame && jpegFrame.length >= 64) {
                streamRes.destroy();
                req.destroy();
                return resolve(jpegFrame);
              }

              if (totalBytes > MAX_SNAPSHOT_BYTES) {
                streamRes.destroy();
                req.destroy();
                return resolve(null);
              }
            });

            streamRes.on("end", () => {
              const combined = Buffer.concat(chunks, totalBytes);
              const jpegFrame = extractFirstJpegFrame(combined);
              resolve(jpegFrame && jpegFrame.length >= 64 ? jpegFrame : null);
            });

            streamRes.on("error", () => resolve(null));
          });

          req.on("error", () => resolve(null));
          req.on("timeout", () => {
            req.destroy();
            resolve(null);
          });
        } catch {
          resolve(null);
        }
      });
    };

    // 1. Try configured capture endpoint
    let frame = await tryFetchFrame(captureEndpoint);

    // 2. If capture endpoint failed, try the stream endpoint
    if (!frame) {
      const streamEndpoint = this.getDefaultStreamUrl();
      if (streamEndpoint !== captureEndpoint) {
        frame = await tryFetchFrame(streamEndpoint);
      }
    }

    if (!frame || frame.length < 64) {
      return {
        success: false,
        simulated: false,
        message: "Failed to capture JPEG snapshot from ESP32-CAM. Verify the camera is powered on and streaming.",
      };
    }

    try {
      fsLib.writeFileSync(targetPath, frame);
      logger.info(
        `[camera] Saved verified ESP32-CAM JPEG snapshot (${frame.length} bytes) to ${targetPath}`
      );
      this.lastStatus = {
        online: true,
        verifiedAtMs: Date.now(),
        targetUrl: captureEndpoint,
        statusCode: 200,
        message: "ESP32-CAM snapshot captured",
        isVerified: this.config.camera.isVerified,
        failureCount: 0,
        streamReachable: true,
        isCloudEnvironment: this.config.isCloudEnvironment,
      };
      return {
        success: true,
        simulated: false,
        message: "Snapshot captured from ESP32-CAM and saved to /public/media/",
        file: {
          filename: safeName,
          url: `/media/${safeName}`,
          sizeBytes: frame.length,
        },
      };
    } catch (writeErr: any) {
      if (fsLib.existsSync(targetPath)) {
        try { fsLib.unlinkSync(targetPath); } catch {}
      }
      return {
        success: false,
        simulated: false,
        message: `Failed to write snapshot to disk: ${writeErr?.message}`,
      };
    }
  }
}

