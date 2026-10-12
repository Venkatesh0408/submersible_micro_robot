import fs from "fs";
import path from "path";
import argon2 from "argon2";
import pg from "pg";

const { Pool } = pg;

export interface MissionControlUser {
  id: string | number;
  username: string;
  phone: string | null;
  role: string;
  createdAt?: string;
}

export class AuthError extends Error {
  status: number;
  code: string;

  constructor(message: string, status = 400, code = "AUTH_ERROR") {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
  }
}

export interface ValidatedRegistrationInput {
  username: string;
  password: string;
  phone: string | null;
}

export interface ValidatedLoginInput {
  username: string;
  password: string;
}

const USERNAME_RE = /^[a-zA-Z0-9_.@-]{3,32}$/;
const PHONE_CHARS_RE = /^[+]?[0-9()\-.\s]{5,25}$/;

export function validateRegistrationInput(input: {
  username?: unknown;
  password?: unknown;
  phone?: unknown;
}): ValidatedRegistrationInput {
  const rawUsername = typeof input.username === "string" ? input.username.trim() : "";
  const rawPassword = typeof input.password === "string" ? input.password : "";
  const rawPhone =
    input.phone === undefined || input.phone === null
      ? ""
      : typeof input.phone === "string"
        ? input.phone.trim()
        : String(input.phone).trim();

  if (!rawUsername || !rawPassword) {
    throw new AuthError("Username and password are required", 400, "MISSING_CREDENTIALS");
  }
  if (rawUsername.length < 3 || rawUsername.length > 32) {
    throw new AuthError("Username must be between 3 and 32 characters", 400, "INVALID_USERNAME");
  }
  if (!USERNAME_RE.test(rawUsername)) {
    throw new AuthError(
      "Username may only contain letters, numbers, underscores, hyphens, dots, or @",
      400,
      "INVALID_USERNAME"
    );
  }
  if (rawPassword.length < 6) {
    throw new AuthError("Password must be at least 6 characters", 400, "INVALID_PASSWORD");
  }
  if (rawPassword.length > 128) {
    throw new AuthError("Password must not exceed 128 characters", 400, "INVALID_PASSWORD");
  }

  let normalizedPhone: string | null = null;
  if (rawPhone.length > 0) {
    const digitCount = (rawPhone.match(/\d/g) || []).length;
    if (!PHONE_CHARS_RE.test(rawPhone) || digitCount < 5 || digitCount > 15) {
      throw new AuthError("Enter a valid phone number or leave it blank", 400, "INVALID_PHONE");
    }
    normalizedPhone = rawPhone;
  }

  return {
    username: rawUsername,
    password: rawPassword,
    phone: normalizedPhone,
  };
}

export function validateLoginInput(input: {
  username?: unknown;
  password?: unknown;
}): ValidatedLoginInput {
  const rawUsername = typeof input.username === "string" ? input.username.trim() : "";
  const rawPassword = typeof input.password === "string" ? input.password : "";

  if (!rawUsername || !rawPassword) {
    throw new AuthError("Username and password required", 400, "MISSING_CREDENTIALS");
  }

  return {
    username: rawUsername,
    password: rawPassword,
  };
}

export interface AuthStoreAdapter {
  readonly backendType: "supabase-rpc" | "postgres" | "file";
  registerUser(input: {
    username?: unknown;
    password?: unknown;
    phone?: unknown;
  }): Promise<MissionControlUser>;
  authenticateUser(input: {
    username?: unknown;
    password?: unknown;
  }): Promise<MissionControlUser>;
  getUserByUsername?(username: string): Promise<MissionControlUser | null>;
}

interface StoredFileUser {
  id: number | string;
  username: string;
  passwordHash: string;
  phone: string | null;
  role: string;
  createdAt: string;
  faceRegistered?: boolean;
  referenceFace?: string | null;
}

const DEFAULT_VSTY_USER: StoredFileUser = {
  id: 1,
  username: "vsty",
  passwordHash:
    "$argon2id$v=19$m=65536,p=4,t=3$2kKBGWP5Bp/vatQPfSDzug$+mG5Ie33mg1hJ7R3u/JSfOU6j4SGp1F5Q3sFmGfM9Co",
  phone: null,
  role: "admin",
  createdAt: "2026-01-01T00:00:00.000Z",
  faceRegistered: true,
  referenceFace: null,
};

export class FileAuthStore implements AuthStoreAdapter {
  readonly backendType = "file" as const;
  private readonly filePath: string;
  private users: StoredFileUser[] = [];

  constructor(filePath?: string, seedDefaultAdmin = true) {
    this.filePath = filePath || path.join(process.cwd(), "users_db.json");
    this.load(seedDefaultAdmin);
  }

  private load(seedDefaultAdmin: boolean): void {
    if (fs.existsSync(this.filePath)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, "utf8"));
        if (Array.isArray(parsed)) {
          this.users = parsed.map((u, idx) => ({
            id: u.id ?? idx + 1,
            username: String(u.username || ""),
            passwordHash: String(u.passwordHash || ""),
            phone: u.phone ?? null,
            role: String(u.role || "operator"),
            createdAt: String(u.createdAt || new Date().toISOString()),
            faceRegistered: Boolean(u.faceRegistered),
            referenceFace: u.referenceFace ?? null,
          }));
        }
      } catch {
        this.users = [];
      }
    }
    if (seedDefaultAdmin && !this.users.some((u) => u.username.toLowerCase() === "vsty")) {
      this.users.unshift({ ...DEFAULT_VSTY_USER });
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, JSON.stringify(this.users, null, 2), "utf8");
  }

  async registerUser(input: {
    username?: unknown;
    password?: unknown;
    phone?: unknown;
  }): Promise<MissionControlUser> {
    const { username, password, phone } = validateRegistrationInput(input);
    this.load(false);

    const exists = this.users.some((u) => u.username.toLowerCase() === username.toLowerCase());
    if (exists) {
      throw new AuthError("Username already exists", 409, "DUPLICATE_USERNAME");
    }

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    const nextId =
      this.users.reduce((max, u) => {
        const num = typeof u.id === "number" ? u.id : parseInt(String(u.id), 10);
        return Number.isFinite(num) && num > max ? num : max;
      }, 0) + 1;

    const record: StoredFileUser = {
      id: nextId,
      username,
      passwordHash,
      phone,
      role: "operator",
      createdAt: new Date().toISOString(),
    };

    this.users.push(record);
    this.save();

    return {
      id: record.id,
      username: record.username,
      phone: record.phone,
      role: record.role,
      createdAt: record.createdAt,
    };
  }

  async authenticateUser(input: {
    username?: unknown;
    password?: unknown;
  }): Promise<MissionControlUser> {
    const { username, password } = validateLoginInput(input);
    this.load(false);

    const user = this.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
    if (!user) {
      throw new AuthError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    let isValid = false;
    try {
      isValid = await argon2.verify(user.passwordHash, password);
    } catch {
      isValid = false;
    }

    if (!isValid) {
      throw new AuthError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    return {
      id: user.id,
      username: user.username,
      phone: user.phone ?? null,
      role: user.role || "operator",
      createdAt: user.createdAt,
    };
  }

  async getUserByUsername(username: string): Promise<MissionControlUser | null> {
    this.load(false);
    const user = this.users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
    if (!user) return null;
    return {
      id: user.id,
      username: user.username,
      phone: user.phone ?? null,
      role: user.role || "operator",
      createdAt: user.createdAt,
    };
  }
}

export class PostgresAuthStore implements AuthStoreAdapter {
  readonly backendType = "postgres" as const;
  private pool: pg.Pool;
  private initialized = false;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false },
    });
  }

  private async ensureSchema(): Promise<void> {
    if (this.initialized) return;
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS public.mission_control_users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        phone TEXT,
        role TEXT NOT NULL DEFAULT 'operator',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE UNIQUE INDEX IF NOT EXISTS mission_control_users_username_lower_idx
        ON public.mission_control_users (LOWER(username));
    `);
    this.initialized = true;
  }

  async registerUser(input: {
    username?: unknown;
    password?: unknown;
    phone?: unknown;
  }): Promise<MissionControlUser> {
    const { username, password, phone } = validateRegistrationInput(input);
    await this.ensureSchema();

    const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
    try {
      const result = await this.pool.query(
        `INSERT INTO public.mission_control_users (username, password_hash, phone, role)
         VALUES ($1, $2, $3, 'operator')
         RETURNING id, username, phone, role, created_at`,
        [username, passwordHash, phone]
      );
      const row = result.rows[0];
      return {
        id: row.id,
        username: row.username,
        phone: row.phone ?? null,
        role: row.role || "operator",
        createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
      };
    } catch (err: any) {
      if (err?.code === "23505" || /duplicate|unique|already exists/i.test(err?.message || "")) {
        throw new AuthError("Username already exists", 409, "DUPLICATE_USERNAME");
      }
      throw err;
    }
  }

  async authenticateUser(input: {
    username?: unknown;
    password?: unknown;
  }): Promise<MissionControlUser> {
    const { username, password } = validateLoginInput(input);
    await this.ensureSchema();

    const result = await this.pool.query(
      `SELECT id, username, password_hash, phone, role, created_at
       FROM public.mission_control_users
       WHERE LOWER(username) = LOWER($1)
       LIMIT 1`,
      [username]
    );
    const row = result.rows[0];
    if (!row) {
      throw new AuthError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    const hash: string = String(row.password_hash || "");
    let isValid = false;
    if (hash.startsWith("$argon2")) {
      try {
        isValid = await argon2.verify(hash, password);
      } catch {
        isValid = false;
      }
    } else {
      // Fallback for pgcrypto crypt() hashes ($2a$ / $2b$ / $bf$)
      const check = await this.pool.query(
        `SELECT (password_hash = crypt($1, password_hash)) AS matched
         FROM public.mission_control_users
         WHERE id = $2`,
        [password, row.id]
      );
      isValid = Boolean(check.rows[0]?.matched);
    }

    if (!isValid) {
      throw new AuthError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    return {
      id: row.id,
      username: row.username,
      phone: row.phone ?? null,
      role: row.role || "operator",
      createdAt: row.created_at ? new Date(row.created_at).toISOString() : undefined,
    };
  }
}

const SECRET_HEADER_NAMES = [
  "x-mc-backend-secret",
  "x-mc-auth-secret",
  "x-mc-secret",
  "x-mission-control-secret",
  "x-mission-control-backend-secret",
  "x-mission-control-auth-secret",
  "x-backend-secret",
  "x-backend-auth-secret",
  "x-auth-secret",
  "x-api-secret",
  "x-internal-secret",
  "x-rpc-secret",
  "x-supabase-secret",
];

const EXPLICIT_SECRET_ENV_KEYS = [
  "MC_BACKEND_SECRET",
  "MC_AUTH_SECRET",
  "MC_SECRET",
  "MISSION_CONTROL_BACKEND_SECRET",
  "MISSION_CONTROL_AUTH_SECRET",
  "MISSION_CONTROL_SECRET",
  "SUPABASE_BACKEND_SECRET",
  "SUPABASE_AUTH_SECRET",
  "SUPABASE_RPC_SECRET",
  "BACKEND_AUTH_SECRET",
  "BACKEND_SECRET",
  "AUTH_BACKEND_SECRET",
  "AUTH_SECRET",
];

const SERVICE_KEY_ENV_KEYS = [
  "SUPABASE_SERVICE_ROLE_KEY",
  "SUPABASE_SECRET_KEY",
  "SUPABASE_SERVICE_KEY",
];

export class SupabaseRpcAuthStore implements AuthStoreAdapter {
  readonly backendType = "supabase-rpc" as const;
  private readonly supabaseUrl: string;
  private readonly anonKey: string;
  private cachedWinningSecretEnvKey: string | null = null;
  private cachedWinningKeyEnvKey: string | null = null;
  private lastAuthDiagnostic: string = "untested";

  constructor(supabaseUrl: string, anonKey: string) {
    this.supabaseUrl = supabaseUrl.replace(/\/+$/, "");
    this.anonKey = anonKey;
  }

  getDiagnosticStatus() {
    return {
      backendType: this.backendType,
      supabaseUrlConfigured: Boolean(this.supabaseUrl),
      lastAuthDiagnostic: this.lastAuthDiagnostic,
      winningSecretEnvKey: this.cachedWinningSecretEnvKey,
      winningKeyEnvKey: this.cachedWinningKeyEnvKey,
    };
  }

  private getCandidateApiKeys(): Array<{ envKey: string; value: string }> {
    const out: Array<{ envKey: string; value: string }> = [];
    const seen = new Set<string>();

    if (this.cachedWinningKeyEnvKey && process.env[this.cachedWinningKeyEnvKey]) {
      const v = process.env[this.cachedWinningKeyEnvKey]!.trim();
      out.push({ envKey: this.cachedWinningKeyEnvKey, value: v });
      seen.add(v);
    }

    for (const k of SERVICE_KEY_ENV_KEYS) {
      const v = process.env[k]?.trim();
      if (v && !seen.has(v)) {
        out.push({ envKey: k, value: v });
        seen.add(v);
      }
    }

    // Any env var value starting with sb_secret_
    for (const [k, rawVal] of Object.entries(process.env)) {
      const v = rawVal?.trim();
      if (v && v.startsWith("sb_secret_") && !seen.has(v)) {
        out.push({ envKey: k, value: v });
        seen.add(v);
      }
    }

    if (this.anonKey && !seen.has(this.anonKey)) {
      out.push({ envKey: "SUPABASE_ANON_KEY", value: this.anonKey });
      seen.add(this.anonKey);
    }

    return out;
  }

  private getCandidateSecrets(): Array<{ envKey: string; value: string }> {
    const out: Array<{ envKey: string; value: string }> = [];
    const seen = new Set<string>();

    if (this.cachedWinningSecretEnvKey && process.env[this.cachedWinningSecretEnvKey]) {
      const v = process.env[this.cachedWinningSecretEnvKey]!.trim();
      out.push({ envKey: this.cachedWinningSecretEnvKey, value: v });
      seen.add(v);
    }

    for (const k of EXPLICIT_SECRET_ENV_KEYS) {
      const v = process.env[k]?.trim();
      if (v && !seen.has(v)) {
        out.push({ envKey: k, value: v });
        seen.add(v);
      }
    }

    for (const [k, rawVal] of Object.entries(process.env)) {
      if (!rawVal) continue;
      if (/SECRET|PASSWORD|TOKEN|KEY/i.test(k) && !/^VITE_|^npm_|^ANTIGRAVITY_/i.test(k)) {
        const v = rawVal.trim();
        if (v && !seen.has(v)) {
          out.push({ envKey: k, value: v });
          seen.add(v);
        }
      }
    }

    return out;
  }

  private buildHeaders(apiKey: string, secretValue?: string): Record<string, string> {
    const headers: Record<string, string> = {
      apikey: apiKey,
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    };
    if (secretValue) {
      for (const h of SECRET_HEADER_NAMES) {
        headers[h] = secretValue;
      }
    }
    return headers;
  }

  private async invokeRpc(
    rpcName: "mc_register_user" | "mc_authenticate_user",
    payload: Record<string, unknown>
  ): Promise<{ status: number; body: any }> {
    const apiKeys = this.getCandidateApiKeys();
    const secrets = this.getCandidateSecrets();

    // Build attempt combinations: (apiKey, secret)
    const attempts: Array<{ keyEnv: string; apiKey: string; secretEnv?: string; secret?: string }> = [];
    for (const k of apiKeys) {
      if (secrets.length === 0) {
        attempts.push({ keyEnv: k.envKey, apiKey: k.value });
      } else {
        for (const s of secrets) {
          attempts.push({
            keyEnv: k.envKey,
            apiKey: k.value,
            secretEnv: s.envKey,
            secret: s.value,
          });
        }
        attempts.push({ keyEnv: k.envKey, apiKey: k.value });
      }
    }

    let lastStatus = 500;
    let lastBody: any = null;

    for (const attempt of attempts) {
      const res = await fetch(`${this.supabaseUrl}/rest/v1/rpc/${rpcName}`, {
        method: "POST",
        headers: this.buildHeaders(attempt.apiKey, attempt.secret),
        body: JSON.stringify(payload),
      });

      const text = await res.text();
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { message: text };
      }

      lastStatus = res.status;
      lastBody = parsed;

      const isUnauthorizedBackend =
        res.status === 401 &&
        parsed?.code === "42501" &&
        /Unauthorized backend request/i.test(parsed?.message || "");

      const isInvalidApiKey =
        res.status === 401 && /Invalid API key|JWT/i.test(parsed?.message || "");

      if (!isUnauthorizedBackend && !isInvalidApiKey) {
        // The backend authorization check passed! Cache this combination.
        this.cachedWinningKeyEnvKey = attempt.keyEnv;
        if (attempt.secretEnv) {
          this.cachedWinningSecretEnvKey = attempt.secretEnv;
        }
        this.lastAuthDiagnostic = "authorized";
        return { status: res.status, body: parsed };
      }
    }

    this.lastAuthDiagnostic = "unauthorized_backend_request";
    return { status: lastStatus, body: lastBody };
  }

  private normalizeRpcUser(body: any, fallbackUsername: string, fallbackPhone: string | null): MissionControlUser | null {
    if (!body) return null;
    const candidate = Array.isArray(body) ? body[0] : body.user ? body.user : body;
    if (!candidate || typeof candidate !== "object") return null;

    if (candidate.success === false) {
      return null;
    }

    // PostgREST composite type returning all nulls when no row matched
    if (
      candidate.id === null &&
      candidate.username === null &&
      !candidate.user_id
    ) {
      return null;
    }

    const username = candidate.username || fallbackUsername;
    const id = candidate.id ?? candidate.user_id ?? username;
    if (!username) return null;

    return {
      id,
      username: String(username),
      phone: candidate.phone !== undefined ? candidate.phone : fallbackPhone,
      role: String(candidate.role || "operator"),
      createdAt: candidate.created_at || candidate.createdAt || undefined,
    };
  }

  async registerUser(input: {
    username?: unknown;
    password?: unknown;
    phone?: unknown;
  }): Promise<MissionControlUser> {
    const { username, password, phone } = validateRegistrationInput(input);

    const { status, body } = await this.invokeRpc("mc_register_user", {
      p_username: username,
      p_password: password,
      p_phone: phone,
    });

    if (status >= 200 && status < 300) {
      if (body && typeof body === "object" && body.success === false) {
        const msg = String(body.message || body.error || "Registration failed");
        if (/already exists|duplicate|taken/i.test(msg)) {
          throw new AuthError("Username already exists", 409, "DUPLICATE_USERNAME");
        }
        throw new AuthError(msg, 400, "REGISTRATION_REJECTED");
      }
      const user = this.normalizeRpcUser(body, username, phone);
      if (user) return user;
    }

    const errCode = String(body?.code || "");
    const errMsg = String(body?.message || body?.error || "Registration failed");

    if (errCode === "23505" || /already exists|duplicate|unique|taken/i.test(errMsg)) {
      throw new AuthError("Username already exists", 409, "DUPLICATE_USERNAME");
    }
    if (errCode === "22023" || /username|password|phone|short|invalid/i.test(errMsg)) {
      throw new AuthError(errMsg, 400, "VALIDATION_ERROR");
    }
    if (errCode === "42501" && /Unauthorized backend request/i.test(errMsg)) {
      throw new AuthError(
        "Backend database authorization secret is not configured.",
        503,
        "BACKEND_AUTH_UNCONFIGURED"
      );
    }

    throw new AuthError(errMsg, 500, "SUPABASE_RPC_ERROR");
  }

  async authenticateUser(input: {
    username?: unknown;
    password?: unknown;
  }): Promise<MissionControlUser> {
    const { username, password } = validateLoginInput(input);

    const { status, body } = await this.invokeRpc("mc_authenticate_user", {
      p_username: username,
      p_password: password,
    });

    if (status >= 200 && status < 300) {
      const user = this.normalizeRpcUser(body, username, null);
      if (!user) {
        throw new AuthError("Invalid credentials", 401, "INVALID_CREDENTIALS");
      }
      return user;
    }

    const errCode = String(body?.code || "");
    const errMsg = String(body?.message || body?.error || "");

    if (
      errCode === "28000" ||
      errCode === "28P01" ||
      errCode === "P0001" ||
      /invalid credentials|invalid username|invalid password|not found|incorrect/i.test(errMsg)
    ) {
      throw new AuthError("Invalid credentials", 401, "INVALID_CREDENTIALS");
    }

    if (errCode === "42501" && /Unauthorized backend request/i.test(errMsg)) {
      throw new AuthError(
        "Backend database authorization secret is not configured.",
        503,
        "BACKEND_AUTH_UNCONFIGURED"
      );
    }

    throw new AuthError("Invalid credentials", 401, "INVALID_CREDENTIALS");
  }
}

function isRealSupabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith("https://")) return false;
  if (trimmed.includes("your-project-ref.supabase.co")) return false;
  return true;
}

function isRealDatabaseUrl(url: string | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed.startsWith("postgres://") && !trimmed.startsWith("postgresql://")) return false;
  if (trimmed.includes("user:password@host")) return false;
  return true;
}

export class HybridCloudAuthStore implements AuthStoreAdapter {
  private readonly primary: SupabaseRpcAuthStore;
  private readonly fallbackPg: PostgresAuthStore | null;

  constructor(primary: SupabaseRpcAuthStore, fallbackPg: PostgresAuthStore | null) {
    this.primary = primary;
    this.fallbackPg = fallbackPg;
  }

  get backendType(): "supabase-rpc" | "postgres" | "file" {
    return this.primary.backendType;
  }

  getDiagnosticStatus() {
    return {
      ...this.primary.getDiagnosticStatus(),
      postgresFallbackConfigured: Boolean(this.fallbackPg),
    };
  }

  async registerUser(input: {
    username?: unknown;
    password?: unknown;
    phone?: unknown;
  }): Promise<MissionControlUser> {
    try {
      return await this.primary.registerUser(input);
    } catch (err: any) {
      if (err instanceof AuthError && err.code === "BACKEND_AUTH_UNCONFIGURED" && this.fallbackPg) {
        return await this.fallbackPg.registerUser(input);
      }
      throw err;
    }
  }

  async authenticateUser(input: {
    username?: unknown;
    password?: unknown;
  }): Promise<MissionControlUser> {
    try {
      return await this.primary.authenticateUser(input);
    } catch (err: any) {
      if (err instanceof AuthError && err.code === "BACKEND_AUTH_UNCONFIGURED" && this.fallbackPg) {
        return await this.fallbackPg.authenticateUser(input);
      }
      throw err;
    }
  }
}

export function createDefaultAuthStore(): AuthStoreAdapter {
  const testFileOverride = process.env.AUTH_USERS_FILE?.trim();
  if (testFileOverride) {
    return new FileAuthStore(testFileOverride);
  }

  const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const supabaseKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SECRET_KEY ||
    process.env.VITE_SUPABASE_ANON_KEY ||
    process.env.SUPABASE_ANON_KEY ||
    "";

  const pgStore = isRealDatabaseUrl(process.env.DATABASE_URL)
    ? new PostgresAuthStore(process.env.DATABASE_URL!)
    : null;

  if (isRealSupabaseUrl(supabaseUrl) && supabaseKey && !supabaseKey.includes("your-anon-key")) {
    const rpcStore = new SupabaseRpcAuthStore(supabaseUrl, supabaseKey);
    return pgStore ? new HybridCloudAuthStore(rpcStore, pgStore) : rpcStore;
  }

  if (pgStore) {
    return pgStore;
  }

  return new FileAuthStore();
}

let activeAuthStore: AuthStoreAdapter = createDefaultAuthStore();

export function getAuthStore(): AuthStoreAdapter {
  return activeAuthStore;
}

export function setAuthStore(store: AuthStoreAdapter): void {
  activeAuthStore = store;
}

