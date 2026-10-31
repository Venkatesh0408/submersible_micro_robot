import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import {
  FileAuthStore,
  setAuthStore,
  getAuthStore,
} from "./authStore.js";
import { getRobotConfig, saveRobotConfig, updateLastVerified, RobotConfig } from "./database.js";
import { validateCamUrl, isValidJpeg } from "./hardware/cameraService.js";

process.env.SKIP_SERVER_LISTEN = "true";

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
 * Creates a synthetic valid JPEG buffer that satisfies isValidJpeg() requirements
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
  console.log("VSTY SUBMERSIBLE MICRO ROBOT — ROBOT & CAMERA CONFIG TEST SUITE");
  console.log("==========================================================\n");

  const validJpeg = createSyntheticValidJpeg(320, 240);
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsty-config-test-"));
  const testDbFile = path.join(tmpDir, "users_test_db.json");

  const { default: app } = await import("./server.js");
  const originalStore = getAuthStore();
  const fileStore = new FileAuthStore(testDbFile);
  setAuthStore(fileStore);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address() as net.AddressInfo;
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  // Start a local mock camera server
  let mockCamPort = 0;
  let mockMode: "valid" | "timeout" | "invalid_content" | "down" = "valid";

  const mockCameraServer = http.createServer((req, res) => {
    if (mockMode === "timeout") {
      // Do not respond
      return;
    }
    if (mockMode === "invalid_content") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<html>Not an image</html>");
      return;
    }
    if (req.url === "/capture" || req.url === "/stream") {
      res.writeHead(200, { "Content-Type": "image/jpeg" });
      res.end(validJpeg);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  });

  await new Promise<void>((resolve) => mockCameraServer.listen(0, "127.0.0.1", resolve));
  mockCamPort = (mockCameraServer.address() as net.AddressInfo).port;

  try {
    // ----------------------------------------------------------
    // 1. SETUP TWO OPERATOR ACCOUNTS FOR ISOLATION TESTING
    // ----------------------------------------------------------
    console.log("1. User Setup & Authentication:");

    const reg1 = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator_one", password: "Password123!" }),
    });
    const data1 = await reg1.json();
    assert.equal(data1.success, true);
    const token1 = data1.token;

    const reg2 = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "operator_two", password: "Password123!" }),
    });
    const data2 = await reg2.json();
    assert.equal(data2.success, true);
    const token2 = data2.token;

    console.log("  [PASS] Registered operator_one and operator_two");

    // ----------------------------------------------------------
    // 2. RETRIEVE DEFAULT CONFIGURATION (EMPTY / UNCONFIGURED)
    // ----------------------------------------------------------
    console.log("\n2. Default Robot Configuration Retrieval:");

    await runTest("Returns clean default configuration when user has no saved config", async () => {
      const res = await fetch(`${baseUrl}/api/robot/config`, {
        headers: { Authorization: `Bearer ${token1}` },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.ok(data.config);
      assert.equal(data.config.streamPort, 81);
      assert.equal(data.config.capturePort, 80);
      assert.equal(data.config.streamPath, "/stream");
      assert.equal(data.config.capturePath, "/capture");
      assert.equal(data.config.proxyStreamUrl, "/api/camera/stream");
    });

    await runTest("Rejects unauthenticated GET /api/robot/config with 401 Unauthorized", async () => {
      const res = await fetch(`${baseUrl}/api/robot/config`);
      assert.equal(res.status, 401);
    });

    // ----------------------------------------------------------
    // 3. DYNAMIC IP CONFIGURATION & PERSISTENCE PER USER
    // ----------------------------------------------------------
    console.log("\n3. Dynamic IP Configuration, Validation & User Isolation:");

    await runTest("Rejects invalid IP addresses and malformed ports with descriptive error", async () => {
      // 1. Invalid port
      const badPortRes = await fetch(`${baseUrl}/api/robot/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token1}`,
        },
        body: JSON.stringify({
          cameraIp: "192.168.1.100",
          streamPort: 99999,
        }),
      });
      assert.equal(badPortRes.status, 400);

      // 2. Disallowed SSRF address (loopback without test flag)
      const loopbackRes = await fetch(`${baseUrl}/api/robot/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token1}`,
        },
        body: JSON.stringify({
          cameraIp: "127.0.0.1",
        }),
      });
      assert.equal(loopbackRes.status, 400);
      const loopbackData = await loopbackRes.json();
      assert.equal(loopbackData.status, "Invalid IP");

      // 3. Cloud metadata
      const metaRes = await fetch(`${baseUrl}/api/robot/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token1}`,
        },
        body: JSON.stringify({
          cameraIp: "169.254.169.254",
        }),
      });
      assert.equal(metaRes.status, 400);
    });

    await runTest("Operator One saves Location 1 configuration (192.168.1.184) permanently", async () => {
      const saveRes = await fetch(`${baseUrl}/api/robot/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token1}`,
        },
        body: JSON.stringify({
          robotName: "VSTY Sentinel Alpha",
          cameraIp: "192.168.1.184",
          streamPort: 81,
          capturePort: 80,
          streamPath: "/stream",
          capturePath: "/capture",
          connectionMode: "LOCAL_GATEWAY",
        }),
      });
      assert.equal(saveRes.status, 200);
      const data = await saveRes.json();
      assert.equal(data.success, true);
      assert.equal(data.config.cameraIp, "192.168.1.184");
      assert.equal(data.config.streamUrl, "http://192.168.1.184:81/stream");
      assert.equal(data.config.captureUrl, "http://192.168.1.184:80/capture");
    });

    await runTest("Operator Two saves Location 2 configuration (192.168.0.105) independently", async () => {
      const saveRes = await fetch(`${baseUrl}/api/robot/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token2}`,
        },
        body: JSON.stringify({
          robotName: "VSTY Sentinel Bravo",
          cameraIp: "192.168.0.105",
          streamPort: 8081,
          capturePort: 8080,
          streamPath: "/live",
          capturePath: "/snap",
          connectionMode: "LOCAL_GATEWAY",
        }),
      });
      assert.equal(saveRes.status, 200);
      const data = await saveRes.json();
      assert.equal(data.success, true);
      assert.equal(data.config.cameraIp, "192.168.0.105");
      assert.equal(data.config.streamUrl, "http://192.168.0.105:8081/live");
    });

    await runTest("User isolation: Operator One and Operator Two retrieve separate saved IPs", async () => {
      // Re-fetch as Operator One
      const res1 = await fetch(`${baseUrl}/api/robot/config`, {
        headers: { Authorization: `Bearer ${token1}` },
      });
      const data1 = await res1.json();
      assert.equal(data1.config.cameraIp, "192.168.1.184");
      assert.equal(data1.config.robotName, "VSTY Sentinel Alpha");

      // Re-fetch as Operator Two
      const res2 = await fetch(`${baseUrl}/api/robot/config`, {
        headers: { Authorization: `Bearer ${token2}` },
      });
      const data2 = await res2.json();
      assert.equal(data2.config.cameraIp, "192.168.0.105");
      assert.equal(data2.config.robotName, "VSTY Sentinel Bravo");
    });

    await runTest("Persistence across simulated logout & re-login", async () => {
      // 1. Logout Operator One
      await fetch(`${baseUrl}/api/auth/logout`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token1}` },
      });

      // 2. Re-login
      const loginRes = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "operator_one", password: "Password123!" }),
      });
      const loginData = await loginRes.json();
      assert.equal(loginData.success, true);
      const newToken1 = loginData.token;

      // 3. Verify camera IP is preserved exactly
      const configRes = await fetch(`${baseUrl}/api/robot/config`, {
        headers: { Authorization: `Bearer ${newToken1}` },
      });
      const configData = await configRes.json();
      assert.equal(configData.config.cameraIp, "192.168.1.184");
    });

    await runTest("Changing location: Operator One moves robot to Location 3 (10.41.235.60)", async () => {
      const updateRes = await fetch(`${baseUrl}/api/robot/config`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token1}`,
        },
        body: JSON.stringify({
          cameraIp: "10.41.235.60",
          streamPort: 81,
          capturePort: 80,
          streamPath: "/stream",
          capturePath: "/capture",
        }),
      });
      assert.equal(updateRes.status, 200);
      const data = await updateRes.json();
      assert.equal(data.config.cameraIp, "10.41.235.60");
      assert.equal(data.config.streamUrl, "http://10.41.235.60:81/stream");
    });

    // ----------------------------------------------------------
    // 4. TEST CONNECTION ENDPOINT & STATUS TRANSITIONS
    // ----------------------------------------------------------
    console.log("\n4. Test Connection Endpoint & Live Verification:");

    await runTest("Test Connection returns 'Invalid IP' for malformed address", async () => {
      const res = await fetch(`${baseUrl}/api/camera/test-connection`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token1}`,
        },
        body: JSON.stringify({
          cameraIp: "999.888.777.666",
        }),
      });
      assert.equal(res.status, 400);
      const data = await res.json();
      assert.equal(data.status, "Invalid IP");
    });

    await runTest("Test Connection honestly reports cloud environment restriction for private LAN IPs", async () => {
      process.env.RENDER = "true";
      try {
        const res = await fetch(`${baseUrl}/api/camera/test-connection`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token1}`,
          },
          body: JSON.stringify({
            cameraIp: "192.168.1.184",
          }),
        });
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.status, "Disconnected");
        assert.match(data.message, /cloud/i);
      } finally {
        delete process.env.RENDER;
      }
    });

    await runTest("Test Connection live verification: Connected with valid JPEG", async () => {
      process.env.ALLOW_TEST_LOOPBACK = "true";
      try {
        mockMode = "valid";
        const res = await fetch(`${baseUrl}/api/camera/test-connection`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token1}`,
          },
          body: JSON.stringify({
            cameraIp: "127.0.0.1",
            streamPort: mockCamPort,
            capturePort: mockCamPort,
            streamPath: "/stream",
            capturePath: "/capture",
          }),
        });
        const data = await res.json();
        assert.equal(data.success, true);
        assert.equal(data.status, "Connected");
        assert.ok(data.latencyMs >= 0);
        assert.equal(data.isVerified, true);
      } finally {
        delete process.env.ALLOW_TEST_LOOPBACK;
      }
    });

    await runTest("Test Connection live verification: Disconnected on non-JPEG payload", async () => {
      process.env.ALLOW_TEST_LOOPBACK = "true";
      try {
        mockMode = "invalid_content";
        const res = await fetch(`${baseUrl}/api/camera/test-connection`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token1}`,
          },
          body: JSON.stringify({
            cameraIp: "127.0.0.1",
            streamPort: mockCamPort,
            capturePort: mockCamPort,
            streamPath: "/stream",
            capturePath: "/capture",
          }),
        });
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.status, "Disconnected");
        assert.match(data.message, /JPEG/i);
      } finally {
        delete process.env.ALLOW_TEST_LOOPBACK;
      }
    });

    await runTest("Test Connection live verification: Connection timeout when camera hangs", async () => {
      process.env.ALLOW_TEST_LOOPBACK = "true";
      try {
        mockMode = "timeout";
        const res = await fetch(`${baseUrl}/api/camera/test-connection`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token1}`,
          },
          body: JSON.stringify({
            cameraIp: "127.0.0.1",
            streamPort: mockCamPort,
            capturePort: mockCamPort,
            streamPath: "/stream",
            capturePath: "/capture",
          }),
        });
        const data = await res.json();
        assert.equal(data.success, false);
        assert.equal(data.status, "Connection timeout");
        assert.match(data.message, /timeout/i);
      } finally {
        delete process.env.ALLOW_TEST_LOOPBACK;
      }
    });

    console.log("\n==========================================================");
    console.log(`ROBOT CONFIG TEST SUMMARY: ${passed} PASSED, ${failed} FAILED`);
    console.log("==========================================================");

    if (failed > 0) {
      process.exit(1);
    }
  } finally {
    setAuthStore(originalStore);
    mockCameraServer.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("ROBOT CONFIG TEST SUITE FATAL ERROR:", err);
  process.exit(1);
});
