import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  validateCamUrl,
  isValidJpeg,
  extractFirstJpegFrame,
  Esp32CameraService,
} from "./cameraService.js";
import { loadHardwareConfig } from "./config.js";

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

/**
 * Creates a synthetic valid JPEG buffer that satisfies isValidJpeg() requirements:
 * - SOI (0xFFD8)
 * - APP0 JFIF
 * - SOF0 (0xFFC0) with non-zero width and height
 * - SOS (0xFFDA)
 * - Entropy scan data
 * - EOI (0xFFD9)
 * - Length >= 64 bytes
 */
function createSyntheticValidJpeg(width = 64, height = 48): Buffer {
  const parts: number[] = [
    0xff, 0xd8, // SOI
    // APP0
    0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // SOF0 (Baseline DCT)
    0xff, 0xc0,
    0x00, 0x11, // length = 17
    0x08,       // precision = 8
    (height >> 8) & 0xff, height & 0xff, // height
    (width >> 8) & 0xff, width & 0xff,   // width
    0x03,       // components = 3
    0x01, 0x22, 0x00,
    0x02, 0x11, 0x01,
    0x03, 0x11, 0x01,
    // SOS
    0xff, 0xda,
    0x00, 0x0c, // length = 12
    0x03, 0x01, 0x00, 0x02, 0x11, 0x03, 0x11, 0x00, 0x3f, 0x00,
  ];
  while (parts.length < 80) {
    parts.push(0xaa);
  }
  parts.push(0xff, 0xd9);
  return Buffer.from(parts);
}

async function main() {
  console.log("==========================================================");
  console.log("VSTY SUBMERSIBLE MICRO ROBOT — CAMERA & STREAM TEST SUITE");
  console.log("==========================================================\n");

  const validJpeg = createSyntheticValidJpeg(320, 240);

  // ----------------------------------------------------------
  // 1. SSRF GUARD & URL VALIDATION
  // ----------------------------------------------------------
  console.log("1. SSRF Guard & IP/URL Validation:");

  await runTest("Rejects loopback addresses (127.0.0.1, localhost, ::1, 0.0.0.0)", () => {
    assert.equal(validateCamUrl("http://127.0.0.1/stream").ok, false);
    assert.equal(validateCamUrl("http://localhost:81/stream").ok, false);
    assert.equal(validateCamUrl("http://[::1]:80/capture").ok, false);
    assert.equal(validateCamUrl("http://0.0.0.0:81/stream").ok, false);
    assert.equal(validateCamUrl("http://127.0.0.2:80/status").ok, false);
  });

  await runTest("Rejects cloud metadata and link-local addresses (169.254.x.x)", () => {
    assert.equal(validateCamUrl("http://169.254.169.254/latest/meta-data").ok, false);
    assert.equal(validateCamUrl("http://169.254.1.1:80/capture").ok, false);
  });

  await runTest("Rejects public, multicast, broadcast, and invalid IPs", () => {
    assert.equal(validateCamUrl("http://8.8.8.8:81/stream").ok, false);
    assert.equal(validateCamUrl("http://224.0.0.1:80/capture").ok, false);
    assert.equal(validateCamUrl("http://256.0.0.1/stream").ok, false);
    assert.equal(validateCamUrl("ftp://192.168.1.100/stream").ok, false);
    assert.equal(validateCamUrl("http://192.168.1.100:70000/stream").ok, false);
    assert.equal(validateCamUrl("not-a-valid-url").ok, false);
  });

  await runTest("Accepts valid RFC1918 private LAN IP addresses and .local mDNS names", () => {
    assert.equal(validateCamUrl("http://192.168.1.100:81/stream").ok, true);
    assert.equal(validateCamUrl("http://10.41.235.60/stream").ok, true);
    assert.equal(validateCamUrl("http://172.20.0.5:80/capture").ok, true);
    assert.equal(validateCamUrl("http://esp32cam.local:81/stream").ok, true);
  });

  // ----------------------------------------------------------
  // 2. JPEG STRUCTURAL INTEGRITY VALIDATION
  // ----------------------------------------------------------
  console.log("\n2. JPEG Structural Validation & Extraction:");

  await runTest("isValidJpeg approves synthetic valid JPEG with SOF and SOS", () => {
    assert.equal(isValidJpeg(validJpeg), true);
  });

  await runTest("isValidJpeg rejects invalid, truncated, and corrupt payloads", () => {
    assert.equal(isValidJpeg(Buffer.alloc(0)), false);
    assert.equal(isValidJpeg(Buffer.from("not a jpeg image")), false);
    assert.equal(isValidJpeg(validJpeg.subarray(0, validJpeg.length - 2)), false);
    assert.equal(isValidJpeg(validJpeg.subarray(0, 30)), false);
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.equal(isValidJpeg(Buffer.concat([pngHeader, Buffer.alloc(60)])), false);
  });

  await runTest("extractFirstJpegFrame extracts standalone JPEG image", () => {
    const extracted = extractFirstJpegFrame(validJpeg);
    assert.ok(extracted);
    assert.equal(isValidJpeg(extracted!), true);
    assert.equal(extracted!.length, validJpeg.length);
  });

  await runTest("extractFirstJpegFrame extracts frame from multipart MJPEG stream chunk", () => {
    const mjpegChunk = Buffer.concat([
      Buffer.from("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + validJpeg.length + "\r\n\r\n"),
      validJpeg,
      Buffer.from("\r\n--frame\r\n"),
    ]);
    const extracted = extractFirstJpegFrame(mjpegChunk);
    assert.ok(extracted);
    assert.equal(isValidJpeg(extracted!), true);
    assert.equal(extracted!.length, validJpeg.length);
  });

  await runTest("extractFirstJpegFrame returns null for corrupt or incomplete stream data", () => {
    const corruptChunk = Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\nGarbageDataNoJpeg\r\n--frame");
    assert.equal(extractFirstJpegFrame(corruptChunk), null);
    assert.equal(extractFirstJpegFrame(Buffer.alloc(0)), null);
  });

  // ----------------------------------------------------------
  // 3. MOCK CAMERA HTTP ENDPOINTS & PROTOCOL HANDLING
  // ----------------------------------------------------------
  console.log("\n3. Mock Camera HTTP Server Tests:");

  let mockBehavior: "valid" | "wrong-type" | "500-error" | "hang" | "oversized" | "redirect" | "reset" = "valid";

  const mockServer = http.createServer((req, res) => {
    if (mockBehavior === "hang") {
      return;
    }
    if (mockBehavior === "reset") {
      req.destroy();
      return;
    }
    if (mockBehavior === "500-error") {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Internal camera hardware error");
      return;
    }
    if (mockBehavior === "wrong-type") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html><body>Not an image</body></html>");
      return;
    }
    if (mockBehavior === "redirect") {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data" });
      res.end();
      return;
    }
    if (mockBehavior === "oversized") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      const chunk = Buffer.alloc(64 * 1024, 0xaa);
      for (let i = 0; i < 100; i++) {
        res.write(chunk);
      }
      res.end();
      return;
    }

    if (req.url === "/capture") {
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Content-Length": validJpeg.length.toString(),
      });
      res.end(validJpeg);
    } else if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ online: true, rssi: -45, psram: true }));
    } else if (req.url === "/stream") {
      res.writeHead(200, {
        "Content-Type": "multipart/x-mixed-replace;boundary=frame",
      });
      const frameHeader = Buffer.from("--frame\r\nContent-Type: image/jpeg\r\n\r\n");
      res.write(frameHeader);
      res.write(validJpeg);
      res.write(Buffer.from("\r\n--frame\r\n"));
      setTimeout(() => res.end(), 100);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise<void>((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
  const addr = mockServer.address() as net.AddressInfo;
  const mockServerPort = addr.port;

  const tmpSnapshotsDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsty-cam-test-"));

  try {
    process.env.ALLOW_TEST_LOOPBACK = "true";
    const testConfig = loadHardwareConfig({
      HARDWARE_MODE: "SIMULATION",
      ESP32_CAM_IP: "127.0.0.1",
      ESP32_CAM_STREAM_PORT: String(mockServerPort),
      ESP32_CAM_CAPTURE_PORT: String(mockServerPort),
      ESP32_CAM_CAPTURE_PATH: "/capture",
      ESP32_CAM_STREAM_PATH: "/stream",
    });

    const camService = new Esp32CameraService(testConfig);
    const captureUrl = `http://127.0.0.1:${mockServerPort}/capture`;
    const streamUrl = `http://127.0.0.1:${mockServerPort}/stream`;

    await runTest("Captures valid snapshot from camera server and writes valid file", async () => {
      mockBehavior = "valid";
      const result = await camService.captureSnapshotToFile(captureUrl, tmpSnapshotsDir, "test_valid.jpg");
      assert.equal(result.success, true);
      assert.equal(result.simulated, false);
      assert.ok(result.file?.filename);
      const filePath = path.join(tmpSnapshotsDir, result.file!.filename);
      assert.ok(fs.existsSync(filePath));
      const readBack = fs.readFileSync(filePath);
      assert.equal(isValidJpeg(readBack), true);
    });

    await runTest("Rejects snapshot when camera returns wrong content type (text/html)", async () => {
      mockBehavior = "wrong-type";
      const result = await camService.captureSnapshotToFile(captureUrl, tmpSnapshotsDir, "test_wrong.jpg");
      assert.equal(result.success, false);
      assert.ok(result.message);
    });

    await runTest("Handles camera HTTP 500 error gracefully", async () => {
      mockBehavior = "500-error";
      const result = await camService.captureSnapshotToFile(captureUrl, tmpSnapshotsDir, "test_500.jpg");
      assert.equal(result.success, false);
      assert.ok(result.message);
    });

    await runTest("Rejects HTTP redirects to prevent redirect-based SSRF", async () => {
      mockBehavior = "redirect";
      const result = await camService.captureSnapshotToFile(captureUrl, tmpSnapshotsDir, "test_redir.jpg");
      assert.equal(result.success, false);
      assert.ok(result.message);
    });

    await runTest("Aborts oversized payload (>5 MB) to prevent OOM denial of service", async () => {
      mockBehavior = "oversized";
      const result = await camService.captureSnapshotToFile(captureUrl, tmpSnapshotsDir, "test_oversized.jpg");
      assert.equal(result.success, false);
      assert.ok(result.message);
    });

    await runTest("Handles connection reset (ECONNRESET) gracefully without crash", async () => {
      mockBehavior = "reset";
      const result = await camService.captureSnapshotToFile(captureUrl, tmpSnapshotsDir, "test_reset.jpg");
      assert.equal(result.success, false);
    });

    await runTest("Handles camera hang / timeout gracefully", async () => {
      mockBehavior = "hang";
      const status = await camService.pingCamera(captureUrl);
      assert.equal(status.online, false);
    });

    await runTest("Cloud environment deployment blocks LAN camera attempts safely", async () => {
      const cloudConfig = loadHardwareConfig({
        HARDWARE_MODE: "SIMULATION",
        ESP32_CAM_IP: "10.41.235.60",
        VERCEL: "1",
      });
      const cloudService = new Esp32CameraService(cloudConfig);
      const pingRes = await cloudService.pingCamera("http://10.41.235.60:81/stream");
      assert.equal(pingRes.online, false);
      assert.equal(pingRes.isCloudEnvironment, true);
      assert.match(pingRes.message, /cloud/i);
    });

  } finally {
    delete process.env.ALLOW_TEST_LOOPBACK;
    mockServer.close();
    fs.rmSync(tmpSnapshotsDir, { recursive: true, force: true });
  }

  // ----------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------
  console.log("\n==========================================================");
  console.log(`CAMERA TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
  console.log("==========================================================");

  if (failed > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("CAMERA TEST SUITE FATAL ERROR:", err);
  process.exit(1);
});
