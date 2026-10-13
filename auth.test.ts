import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import {
  FileAuthStore,
  SupabaseRpcAuthStore,
  setAuthStore,
  getAuthStore,
} from "./authStore.js";

process.env.SKIP_SERVER_LISTEN = "true";
// Keep integration tests deterministic and ensure guest control requests remain simulation-only.
process.env.NODE_ENV = "test";
process.env.HARDWARE_MODE = "SIMULATION";

async function runTests() {
  console.log("=== VSTY Mission Control Authentication Test Suite ===");

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vsty-auth-test-"));
  const testDbFile = path.join(tmpDir, "users_test_db.json");

  const { default: app } = await import("./server.js");
  const originalStore = getAuthStore();
  const fileStore = new FileAuthStore(testDbFile);
  setAuthStore(fileStore);

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (!addr || typeof addr === "string") {
    throw new Error("Failed to bind test HTTP server");
  }
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  try {
    // 1. Registration with username, password, and optional phone number
    console.log("Test 1: Register user with username, password, and optional phone number...");
    const regWithPhoneRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "pilot_alpha",
        password: "StrongPassword!123",
        phone: "+91 98765 43210",
      }),
    });
    assert.equal(regWithPhoneRes.status, 201, "Expected 201 Created for valid registration");
    const regWithPhoneData = await regWithPhoneRes.json();
    assert.equal(regWithPhoneData.success, true);
    assert.equal(regWithPhoneData.user.username, "pilot_alpha");
    assert.equal(regWithPhoneData.user.phone, "+91 98765 43210");
    assert.equal(regWithPhoneData.user.role, "operator");
    assert.ok(regWithPhoneData.token, "Expected JWT token on registration");
    const setCookieHeader = regWithPhoneRes.headers.get("set-cookie") || "";
    assert.ok(setCookieHeader.includes("HttpOnly"), "Expected HttpOnly token cookie");
    console.log("  PASS");

    // 2. Registration without phone number (optional phone omitted / blank)
    console.log("Test 2: Register user without phone number (optional phone)...");
    const regNoPhoneRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "pilot_bravo",
        password: "BravoSecurePassword99",
        phone: "   ",
      }),
    });
    assert.equal(regNoPhoneRes.status, 201, "Expected 201 Created when phone is omitted/empty");
    const regNoPhoneData = await regNoPhoneRes.json();
    assert.equal(regNoPhoneData.success, true);
    assert.equal(regNoPhoneData.user.username, "pilot_bravo");
    assert.equal(regNoPhoneData.user.phone, null);
    console.log("  PASS");

    // 3. Duplicate username rejection (exact and case-insensitive)
    console.log("Test 3: Reject duplicate usernames (exact and case-insensitive)...");
    const dupExactRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "pilot_alpha",
        password: "AnotherPassword123",
      }),
    });
    assert.equal(dupExactRes.status, 409, "Expected 409 Conflict for exact duplicate username");
    const dupExactData = await dupExactRes.json();
    assert.equal(dupExactData.success, false);
    assert.match(dupExactData.message, /already exists/i);

    const dupCaseRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "PILOT_ALPHA",
        password: "AnotherPassword123",
      }),
    });
    assert.equal(dupCaseRes.status, 409, "Expected 409 Conflict for case-insensitive duplicate username");
    console.log("  PASS");

    // 4. Invalid password & input validation
    console.log("Test 4: Reject invalid passwords, usernames, and malformed phone numbers...");
    const shortPwRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "pilot_charlie",
        password: "123",
      }),
    });
    assert.equal(shortPwRes.status, 400, "Expected 400 Bad Request for short password (< 6 chars)");
    const shortPwData = await shortPwRes.json();
    assert.equal(shortPwData.success, false);
    assert.match(shortPwData.message, /at least 6 characters/i);

    const emptyPwRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "pilot_charlie",
        password: "",
      }),
    });
    assert.equal(emptyPwRes.status, 400, "Expected 400 Bad Request for empty password");

    const badPhoneRes = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "pilot_charlie",
        password: "ValidPassword123",
        phone: "not-a-phone",
      }),
    });
    assert.equal(badPhoneRes.status, 400, "Expected 400 Bad Request for invalid phone string");
    console.log("  PASS");

    // 5. Login success & failure
    console.log("Test 5: Login success with correct credentials and failure with wrong password / unknown user...");
    const loginOkRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "pilot_alpha",
        password: "StrongPassword!123",
      }),
    });
    assert.equal(loginOkRes.status, 200, "Expected 200 OK for valid login");
    const loginOkData = await loginOkRes.json();
    assert.equal(loginOkData.success, true);
    assert.equal(loginOkData.user.username, "pilot_alpha");
    assert.equal(loginOkData.user.phone, "+91 98765 43210");
    assert.ok(loginOkData.token);

    const loginWrongPwRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "pilot_alpha",
        password: "WrongPassword999",
      }),
    });
    assert.equal(loginWrongPwRes.status, 401, "Expected 401 Unauthorized for wrong password");
    const loginWrongPwData = await loginWrongPwRes.json();
    assert.equal(loginWrongPwData.success, false);
    assert.match(loginWrongPwData.message, /Invalid credentials/i);

    const loginUnknownRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "nonexistent_operator",
        password: "StrongPassword!123",
      }),
    });
    assert.equal(loginUnknownRes.status, 401, "Expected 401 Unauthorized for unknown user");
    console.log("  PASS");

    // 6. Session token verification (/api/auth/me) & logout (/api/auth/logout)
    console.log("Test 6: Verify JWT session via GET /api/auth/me and logout...");
    const meRes = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${loginOkData.token}` },
    });
    assert.equal(meRes.status, 200);
    const meData = await meRes.json();
    assert.equal(meData.success, true);
    assert.equal(meData.user.username, "pilot_alpha");
    assert.equal(meData.user.phone, "+91 98765 43210");

    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, { method: "POST" });
    assert.equal(logoutRes.status, 200);
    console.log("  PASS");

    // 7. Argon2 hashing & persistence across store re-instantiation
    console.log("Test 7: Verify Argon2id password hashing and persistence across store restart...");
    const rawFile = JSON.parse(fs.readFileSync(testDbFile, "utf8"));
    const storedAlpha = rawFile.find((u: any) => u.username === "pilot_alpha");
    assert.ok(storedAlpha, "Expected pilot_alpha to be persisted on disk");
    assert.ok(
      String(storedAlpha.passwordHash).startsWith("$argon2id$"),
      "Expected passwordHash to be hashed with Argon2id"
    );
    assert.notEqual(storedAlpha.passwordHash, "StrongPassword!123");

    // Re-instantiate store from disk to simulate a fresh server start
    const restartedStore = new FileAuthStore(testDbFile);
    setAuthStore(restartedStore);

    const loginAfterRestartRes = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: "pilot_bravo",
        password: "BravoSecurePassword99",
      }),
    });
    assert.equal(loginAfterRestartRes.status, 200, "Expected persisted account to authenticate after restart");
    const loginAfterRestartData = await loginAfterRestartRes.json();
    assert.equal(loginAfterRestartData.user.username, "pilot_bravo");
    assert.equal(loginAfterRestartData.user.phone, null);
    console.log("  PASS");

    // 8. API authorization: sensitive data and billable operations require a registered session.
    console.log("Test 8: Protect saved history, media writes, billable AI endpoints, and audit logs...");
    const historyAnonRes = await fetch(`${baseUrl}/api/analysis-history`);
    assert.equal(historyAnonRes.status, 401, "Expected 401 for unauthenticated saved-history access");

    const mediaAnonRes = await fetch(`${baseUrl}/api/media/upload`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "should-not-be-created.jpg", fileData: "ZmFrZQ==" }),
    });
    assert.equal(mediaAnonRes.status, 401, "Expected 401 for unauthenticated media writes");

    const imageAnonRes = await fetch(`${baseUrl}/api/analyze-image`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image: "data:image/jpeg;base64,ZmFrZQ==" }),
    });
    assert.equal(imageAnonRes.status, 401, "Expected 401 before calling the image-analysis provider");

    const mapAnonRes = await fetch(`${baseUrl}/api/maps-grounding`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "test" }),
    });
    assert.equal(mapAnonRes.status, 401, "Expected 401 before calling the Maps/AI provider");

    const auditAnonRes = await fetch(`${baseUrl}/api/auth/audit-logs`);
    assert.equal(auditAnonRes.status, 401, "Expected 401 for unauthenticated audit-log access");

    const operatorAuditRes = await fetch(`${baseUrl}/api/auth/audit-logs`, {
      headers: { Authorization: `Bearer ${loginOkData.token}` },
    });
    assert.equal(operatorAuditRes.status, 403, "Expected 403 for non-admin audit-log access");

    const statusRes = await fetch(`${baseUrl}/api/auth/status`);
    assert.equal(statusRes.status, 200);
    const statusData = await statusRes.json();
    assert.equal(statusData.configuredEnvKeys, undefined, "Public status must not reveal environment-variable names");
    assert.equal(statusData.winningSecretEnvKey, undefined, "Public status must not reveal the selected secret variable");

    // Guest mode remains useful for the public demo and simulated mission controls.
    const healthAnonRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthAnonRes.status, 200, "Expected public health data for the demo");

    const guestStartRes = await fetch(`${baseUrl}/api/start`, { method: "POST" });
    assert.equal(guestStartRes.status, 200, "Expected guest simulation start to remain available");
    const guestStopRes = await fetch(`${baseUrl}/api/stop`, { method: "POST" });
    assert.equal(guestStopRes.status, 200, "Expected guest simulation stop to remain available");
    console.log("  PASS");

    // 9. SupabaseRpcAuthStore unit test (verifying RPC payloads, secret headers, and error mapping)
    console.log("Test 8: Verify SupabaseRpcAuthStore RPC calls and backend secret header handling...");
    const realFetch = globalThis.fetch;
    process.env.MC_BACKEND_SECRET = "test-shared-rpc-secret";
    const rpcCalls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];

    globalThis.fetch = (async (input: any, init?: any) => {
      const url = String(input);
      const headers = (init?.headers || {}) as Record<string, string>;
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      rpcCalls.push({ url, headers, body });

      if (headers["x-mc-backend-secret"] !== "test-shared-rpc-secret") {
        return new Response(
          JSON.stringify({ code: "42501", message: "Unauthorized backend request" }),
          { status: 401, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.endsWith("/rest/v1/rpc/mc_register_user")) {
        if (body.p_username === "existing_user") {
          return new Response(
            JSON.stringify({ code: "23505", message: "Username already exists" }),
            { status: 409, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(
          JSON.stringify([
            {
              id: "uuid-1234",
              username: body.p_username,
              phone: body.p_phone,
              role: "operator",
            },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }

      if (url.endsWith("/rest/v1/rpc/mc_authenticate_user")) {
        if (body.p_username === "rpc_pilot" && body.p_password === "RpcPass123!") {
          return new Response(
            JSON.stringify([
              {
                id: "uuid-1234",
                username: "rpc_pilot",
                phone: "+15550001111",
                role: "operator",
              },
            ]),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not Found", { status: 404 });
    }) as typeof fetch;

    try {
      const rpcStore = new SupabaseRpcAuthStore("https://example.supabase.co", "sb_publishable_test");
      const created = await rpcStore.registerUser({
        username: "rpc_pilot",
        password: "RpcPass123!",
        phone: "+15550001111",
      });
      assert.equal(created.username, "rpc_pilot");
      assert.equal(created.phone, "+15550001111");
      assert.equal(rpcCalls[0].body.p_username, "rpc_pilot");
      assert.equal(rpcCalls[0].body.p_phone, "+15550001111");

      await assert.rejects(
        () =>
          rpcStore.registerUser({
            username: "existing_user",
            password: "RpcPass123!",
          }),
        (err: any) => err.status === 409 && /already exists/i.test(err.message)
      );

      const authed = await rpcStore.authenticateUser({
        username: "rpc_pilot",
        password: "RpcPass123!",
      });
      assert.equal(authed.username, "rpc_pilot");

      await assert.rejects(
        () =>
          rpcStore.authenticateUser({
            username: "rpc_pilot",
            password: "WrongPassword",
          }),
        (err: any) => err.status === 401 && /Invalid credentials/i.test(err.message)
      );
      console.log("  PASS");
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.MC_BACKEND_SECRET;
    }

    console.log("\nALL 9 AUTHENTICATION TEST GROUPS PASSED!");
  } finally {
    setAuthStore(originalStore);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

runTests().catch((err) => {
  console.error("AUTH TEST SUITE FAILED:", err);
  process.exit(1);
});
