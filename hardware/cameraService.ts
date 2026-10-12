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
export function validateCamUrl(raw: string): CamUrlValidation {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "Invalid URL" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "Only http/https is allowed" };
  }
  const host = url.hostname.toLowerCase();
  if (host.endsWith(".local")) {
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
  const isPrivate =
    a === 10 ||
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31);
  if (!isPrivate) {
    return {
      ok: false,
      reason: "Only private LAN addresses (10.x, 172.16–31.x, 192.168.x) are allowed",
    };
  }
  return { ok: true, parsedUrl: url };
}

/**
 * Extract the first complete JPEG image (SOI 0xFFD8 .. EOI 0xFFD9) from a buffer
 * that may be either a single JPEG or a multipart/x-mixed-replace MJPEG stream chunk sequence.
 */
export function extractFirstJpegFrame(buffer: Buffer): Buffer | null {
  const soiIdx = buffer.indexOf(JPEG_SOI);
  if (soiIdx < 0) return null;
  const eoiIdx = buffer.indexOf(JPEG_EOI, soiIdx + 2);
  if (eoiIdx < 0) return null;
  return buffer.subarray(soiIdx, eoiIdx + 2);
}

export class Esp32CameraService {
  private config: HardwareConfig;
  private lastStatus: CameraPingStatus = {
    online: false,
    verifiedAtMs: null,
    targetUrl: null,
    message: "ESP32-CAM has not been verified yet.",
  };

  constructor(config: HardwareConfig) {
    this.config = config;
  }

  public updateConfig(config: HardwareConfig): void {
    this.config = config;
  }

  public get status(): CameraPingStatus {
    return { ...this.lastStatus };
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
    const { defaultIp, defaultCapturePort, defaultCapturePath } = this.config.camera;
    const p = defaultCapturePath.startsWith("/") ? defaultCapturePath : `/${defaultCapturePath}`;
    return `http://${defaultIp}:${defaultCapturePort}${p}`;
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
        targetUrl,
        message:
          "Cloud-hosted backend cannot reach a private LAN ESP32-CAM address. Run the backend locally on the same Wi-Fi LAN as the ESP32-CAM.",
      };
      this.lastStatus = status;
      return status;
    }

    const guard = validateCamUrl(targetUrl);
    if (!guard.ok) {
      return {
        online: false,
        verifiedAtMs: Date.now(),
        targetUrl,
        message: guard.reason || "Invalid camera URL",
      };
    }

    const startTime = Date.now();
    const timeoutMs = this.config.camera.pingTimeoutMs;

    return new Promise<CameraPingStatus>((resolve) => {
      let settled = false;
      const finish = (res: CameraPingStatus) => {
        if (settled) return;
        settled = true;
        this.lastStatus = res;
        resolve(res);
      };

      try {
        const protocol = targetUrl.startsWith("https") ? https : http;
        const req = protocol.get(targetUrl, { timeout: timeoutMs }, (res) => {
          const latencyMs = Date.now() - startTime;
          const statusCode = res.statusCode || 0;
          const contentType = res.headers["content-type"] || "video/mjpeg";
          res.destroy();

          if (statusCode >= 200 && statusCode < 300) {
            finish({
              online: true,
              verifiedAtMs: Date.now(),
              targetUrl,
              statusCode,
              contentType,
              latencyMs,
              message: `ESP32-CAM connected over WiFi (${latencyMs}ms)`,
            });
          } else {
            finish({
              online: false,
              verifiedAtMs: Date.now(),
              targetUrl,
              statusCode,
              contentType,
              latencyMs,
              message: `ESP32-CAM responded with HTTP ${statusCode} at ${targetUrl}`,
            });
          }
        });

        req.on("error", (err) => {
          finish({
            online: false,
            verifiedAtMs: Date.now(),
            targetUrl,
            message: `Could not reach ESP32-CAM at ${targetUrl}: ${err.message}`,
          });
        });

        req.on("timeout", () => {
          req.destroy();
          finish({
            online: false,
            verifiedAtMs: Date.now(),
            targetUrl,
            message: `Timeout connecting to ESP32-CAM at ${targetUrl} (${timeoutMs}ms)`,
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
   * Capture a single validated JPEG frame from the ESP32-CAM (either a still `/capture` endpoint
   * or by extracting the first complete JPEG frame from an MJPEG `/stream` endpoint) and save it to mediaDir.
   */
  public async captureSnapshotToFile(
    targetUrl: string,
    mediaDir: string,
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

    const guard = validateCamUrl(targetUrl);
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
    const targetPath = path.join(mediaDir, safeName);
    const timeoutMs = this.config.camera.snapshotTimeoutMs;

    return new Promise<SnapshotCaptureResult>((resolve) => {
      let settled = false;
      const finish = (res: SnapshotCaptureResult) => {
        if (settled) return;
        settled = true;
        resolve(res);
      };

      try {
        const protocol = targetUrl.startsWith("https") ? https : http;
        const req = protocol.get(targetUrl, { timeout: timeoutMs }, (streamRes) => {
          const statusCode = streamRes.statusCode || 0;
          if (statusCode < 200 || statusCode >= 300) {
            streamRes.destroy();
            return finish({
              success: false,
              simulated: false,
              message: `ESP32-CAM returned HTTP ${statusCode} during snapshot capture`,
            });
          }

          const chunks: Buffer[] = [];
          let totalBytes = 0;

          streamRes.on("data", (chunk: Buffer) => {
            chunks.push(chunk);
            totalBytes += chunk.length;

            const combined = Buffer.concat(chunks, totalBytes);
            const jpegFrame = extractFirstJpegFrame(combined);
            if (jpegFrame && jpegFrame.length >= 64) {
              // Complete JPEG frame extracted (works for both single JPEG and infinite MJPEG stream!)
              streamRes.destroy();
              req.destroy();
              try {
                fsLib.writeFileSync(targetPath, jpegFrame);
                logger.info(
                  `[camera] Saved verified ESP32-CAM JPEG snapshot (${jpegFrame.length} bytes) to ${targetPath}`
                );
                this.lastStatus = {
                  online: true,
                  verifiedAtMs: Date.now(),
                  targetUrl,
                  statusCode: 200,
                  message: "ESP32-CAM snapshot captured",
                };
                finish({
                  success: true,
                  simulated: false,
                  message: "Snapshot captured from ESP32-CAM and saved to /public/media/",
                  file: {
                    filename: safeName,
                    url: `/media/${safeName}`,
                    sizeBytes: jpegFrame.length,
                  },
                });
              } catch (writeErr: any) {
                finish({
                  success: false,
                  simulated: false,
                  message: `Failed to write snapshot to disk: ${writeErr?.message}`,
                });
              }
              return;
            }

            if (totalBytes > MAX_SNAPSHOT_BYTES) {
              streamRes.destroy();
              req.destroy();
              finish({
                success: false,
                simulated: false,
                message: "Camera response exceeded maximum frame buffer size without a valid JPEG frame.",
              });
            }
          });

          streamRes.on("end", () => {
            if (settled) return;
            const combined = Buffer.concat(chunks, totalBytes);
            const jpegFrame = extractFirstJpegFrame(combined);
            if (!jpegFrame || jpegFrame.length < 64) {
              finish({
                success: false,
                simulated: false,
                message: "ESP32-CAM response did not contain a valid JPEG image frame.",
              });
              return;
            }
            try {
              fsLib.writeFileSync(targetPath, jpegFrame);
              finish({
                success: true,
                simulated: false,
                message: "Snapshot captured from ESP32-CAM and saved to /public/media/",
                file: {
                  filename: safeName,
                  url: `/media/${safeName}`,
                  sizeBytes: jpegFrame.length,
                },
              });
            } catch (writeErr: any) {
              finish({
                success: false,
                simulated: false,
                message: `Failed to write snapshot to disk: ${writeErr?.message}`,
              });
            }
          });

          streamRes.on("error", (err) => {
            if (settled) return;
            finish({
              success: false,
              simulated: false,
              message: `ESP32-CAM stream error during snapshot: ${err.message}`,
            });
          });
        });

        req.on("error", (err) => {
          finish({
            success: false,
            simulated: false,
            message: `Failed to capture ESP32-CAM frame: ${err.message}`,
          });
        });

        req.on("timeout", () => {
          req.destroy();
          finish({
            success: false,
            simulated: false,
            message: `ESP32-CAM snapshot timed out after ${timeoutMs}ms at ${targetUrl}`,
          });
        });
      } catch (err: any) {
        finish({
          success: false,
          simulated: false,
          message: err?.message || "ESP32-CAM snapshot capture failed",
        });
      }
    });
  }
}
