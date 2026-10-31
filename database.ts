import fsLib from "fs";
import path from "path";
import pkg from "pg";

const { Pool } = pkg;

export interface RobotConfig {
  userId: string;
  robotName: string;
  cameraIp: string;
  streamPort: number;
  capturePort: number;
  streamPath: string;
  capturePath: string;
  connectionMode: "LOCAL_GATEWAY" | "CLOUD_REMOTE";
  lastVerifiedAt: string | null;
  updatedAt: string;
}

// Inspection history & robot configuration store. Uses Neon Postgres when DATABASE_URL is set,
// otherwise falls back to local JSON files so the app still runs offline.
const DB_PATH = path.join(process.cwd(), "database.json");
const CONFIG_PATH = path.join(process.cwd(), "robot_configs.json");

const CONNECTION =
    process.env.DATABASE_URL ||
    process.env.NEON_DATABASE_URL ||
    process.env.neon_db ||
    process.env.neno_db;

let pool: InstanceType<typeof Pool> | null = null;
let ready: Promise<void> | null = null;

if (CONNECTION) {
    pool = new Pool({
        connectionString: CONNECTION,
        ssl: { rejectUnauthorized: true },
        max: 5,
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
    });
    ready = pool
        .query(`
            CREATE TABLE IF NOT EXISTS analysis_history (
                id TEXT PRIMARY KEY,
                data JSONB NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
            CREATE TABLE IF NOT EXISTS robot_configurations (
                user_id TEXT PRIMARY KEY,
                robot_name TEXT NOT NULL DEFAULT 'VSTY Submersible Micro Robot',
                camera_ip TEXT NOT NULL DEFAULT '',
                stream_port INTEGER NOT NULL DEFAULT 81,
                capture_port INTEGER NOT NULL DEFAULT 80,
                stream_path TEXT NOT NULL DEFAULT '/stream',
                capture_path TEXT NOT NULL DEFAULT '/capture',
                connection_mode TEXT NOT NULL DEFAULT 'LOCAL_GATEWAY',
                last_verified_at TIMESTAMPTZ,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
            );
        `)
        .then(() => {
            console.log("[db] Connected to Neon Postgres (analysis_history & robot_configurations ready)");
        })
        .catch((e: unknown) => {
            console.error("[db] Postgres init failed, falling back to file store:", (e as Error).message);
            pool = null;
        });
}

// ---- local file fallback for analysis history ----
function initFile() {
    if (!fsLib.existsSync(DB_PATH)) fsLib.writeFileSync(DB_PATH, "[]");
}
function fileGet(): any[] {
    initFile();
    try {
        return JSON.parse(fsLib.readFileSync(DB_PATH, "utf8"));
    } catch {
        return [];
    }
}
function fileWrite(h: any[]) {
    fsLib.writeFileSync(DB_PATH, JSON.stringify(h, null, 2));
}

// ---- local file fallback for robot configurations ----
function initConfigFile() {
    if (!fsLib.existsSync(CONFIG_PATH)) fsLib.writeFileSync(CONFIG_PATH, "{}");
}
function fileGetConfigs(): Record<string, RobotConfig> {
    initConfigFile();
    try {
        const data = JSON.parse(fsLib.readFileSync(CONFIG_PATH, "utf8"));
        return typeof data === "object" && data !== null ? data : {};
    } catch {
        return {};
    }
}
function fileWriteConfigs(configs: Record<string, RobotConfig>) {
    fsLib.writeFileSync(CONFIG_PATH, JSON.stringify(configs, null, 2));
}

// ==========================================================
// ANALYSIS HISTORY API
// ==========================================================

export async function getHistory() {
    if (ready) await ready;
    if (pool) {
        try {
            const res = await pool.query("SELECT data FROM analysis_history ORDER BY created_at DESC");
            return res.rows.map((r: any) => r.data);
        } catch (e) {
            console.error("[db] getHistory error:", (e as Error).message);
            return [];
        }
    }
    return fileGet();
}

export async function saveHistoryItem(item: any) {
    if (ready) await ready;
    if (pool) {
        try {
            const id = item?.id != null ? String(item.id) : String(Date.now());
            await pool.query(
                "INSERT INTO analysis_history (id, data) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data",
                [id, item]
            );
            return true;
        } catch (e) {
            console.error("[db] saveHistoryItem error:", (e as Error).message);
            return false;
        }
    }
    try {
        const history = fileGet();
        history.unshift(item);
        fileWrite(history);
        return true;
    } catch (e) {
        console.error("Failed to save history item", e);
        return false;
    }
}

export async function deleteHistoryItem(id: string) {
    if (ready) await ready;
    if (pool) {
        try {
            const res = await pool.query("DELETE FROM analysis_history WHERE id = $1", [String(id)]);
            return (res.rowCount ?? 0) > 0;
        } catch (e) {
            console.error("[db] deleteHistoryItem error:", (e as Error).message);
            return false;
        }
    }
    let history = fileGet();
    const initialLength = history.length;
    history = history.filter((item: any) => item.id !== id);
    if (history.length !== initialLength) {
        fileWrite(history);
        return true;
    }
    return false;
}

// ==========================================================
// ROBOT & CAMERA CONFIGURATION API
// ==========================================================

export async function getRobotConfig(userId: string | number): Promise<RobotConfig | null> {
    const uid = String(userId);
    if (ready) await ready;
    if (pool) {
        try {
            const res = await pool.query(
                `SELECT user_id, robot_name, camera_ip, stream_port, capture_port,
                        stream_path, capture_path, connection_mode, last_verified_at, updated_at
                 FROM robot_configurations
                 WHERE user_id = $1`,
                [uid]
            );
            if (res.rows.length === 0) return null;
            const row = res.rows[0];
            return {
                userId: row.user_id,
                robotName: row.robot_name,
                cameraIp: row.camera_ip,
                streamPort: Number(row.stream_port),
                capturePort: Number(row.capture_port),
                streamPath: row.stream_path,
                capturePath: row.capture_path,
                connectionMode: row.connection_mode as "LOCAL_GATEWAY" | "CLOUD_REMOTE",
                lastVerifiedAt: row.last_verified_at ? new Date(row.last_verified_at).toISOString() : null,
                updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : new Date().toISOString(),
            };
        } catch (err: any) {
            console.error("[db] getRobotConfig postgres error:", err.message);
            return null;
        }
    }

    const configs = fileGetConfigs();
    return configs[uid] ?? null;
}

export async function saveRobotConfig(config: RobotConfig): Promise<boolean> {
    const uid = String(config.userId);
    if (ready) await ready;
    if (pool) {
        try {
            await pool.query(
                `INSERT INTO robot_configurations (
                    user_id, robot_name, camera_ip, stream_port, capture_port,
                    stream_path, capture_path, connection_mode, last_verified_at, updated_at
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
                 ON CONFLICT (user_id) DO UPDATE SET
                    robot_name = EXCLUDED.robot_name,
                    camera_ip = EXCLUDED.camera_ip,
                    stream_port = EXCLUDED.stream_port,
                    capture_port = EXCLUDED.capture_port,
                    stream_path = EXCLUDED.stream_path,
                    capture_path = EXCLUDED.capture_path,
                    connection_mode = EXCLUDED.connection_mode,
                    last_verified_at = COALESCE(EXCLUDED.last_verified_at, robot_configurations.last_verified_at),
                    updated_at = now()`,
                [
                    uid,
                    config.robotName || "VSTY Submersible Micro Robot",
                    config.cameraIp || "",
                    config.streamPort || 81,
                    config.capturePort || 80,
                    config.streamPath || "/stream",
                    config.capturePath || "/capture",
                    config.connectionMode || "LOCAL_GATEWAY",
                    config.lastVerifiedAt ? new Date(config.lastVerifiedAt) : null,
                ]
            );
            return true;
        } catch (err: any) {
            console.error("[db] saveRobotConfig postgres error:", err.message);
            return false;
        }
    }

    try {
        const configs = fileGetConfigs();
        configs[uid] = {
            ...config,
            userId: uid,
            updatedAt: new Date().toISOString(),
        };
        fileWriteConfigs(configs);
        return true;
    } catch (err) {
        console.error("[db] saveRobotConfig file error:", err);
        return false;
    }
}

export async function updateLastVerified(userId: string | number, timestamp = new Date().toISOString()): Promise<boolean> {
    const uid = String(userId);
    if (ready) await ready;
    if (pool) {
        try {
            await pool.query(
                `UPDATE robot_configurations
                 SET last_verified_at = $1, updated_at = now()
                 WHERE user_id = $2`,
                [new Date(timestamp), uid]
            );
            return true;
        } catch (err: any) {
            console.error("[db] updateLastVerified error:", err.message);
            return false;
        }
    }

    try {
        const configs = fileGetConfigs();
        if (configs[uid]) {
            configs[uid].lastVerifiedAt = timestamp;
            configs[uid].updatedAt = timestamp;
            fileWriteConfigs(configs);
            return true;
        }
        return false;
    } catch {
        return false;
    }
}
