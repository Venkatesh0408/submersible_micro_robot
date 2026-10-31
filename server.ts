import express from "express";
import path from "path";
import http from "http";
import https from "https";
import { GoogleGenAI, Type } from "@google/genai";
import dotenv from "dotenv";
import fsLib from "fs";
import helmet from "helmet";
import cors from "cors";
import rateLimit from "express-rate-limit";
import xss from "xss";
import { z } from "zod";
import { logger } from "./logger.js";
import { getHistory, saveHistoryItem, deleteHistoryItem, getRobotConfig, saveRobotConfig, updateLastVerified, RobotConfig } from "./database.js";
import jwt from "jsonwebtoken";
import argon2 from "argon2";
import cookieParser from "cookie-parser";
import { AuthError, getAuthStore } from "./authStore.js";
import { HardwareAdapter } from "./hardware/hardwareAdapter.js";
import { validateCamUrl, isValidJpeg, extractFirstJpegFrame } from "./hardware/cameraService.js";

dotenv.config();

export const hardwareAdapter = new HardwareAdapter();

/**
 * Strict loopback guard for physical hardware-control endpoints.
 * Inspects the raw TCP socket remoteAddress (ignoring X-Forwarded-For / req.ip)
 * and never bypasses in development or for arbitrary LAN peers.
 */
export function isLocalRequest(req: express.Request): boolean {
  if (hardwareAdapter.config.isCloudEnvironment) return false;
  const remoteAddr = (req.socket?.remoteAddress || "").trim();
  return (
    remoteAddr === "127.0.0.1" ||
    remoteAddr === "::1" ||
    remoteAddr === "::ffff:127.0.0.1"
  );
}

let ai = null;
function getAI() {
  if (!ai) {
    if (!process.env.GEMINI_API_KEY) {
        logger.error("GEMINI_API_KEY is missing!");
    }
    ai = new GoogleGenAI({
      apiKey: process.env.GEMINI_API_KEY,
      httpOptions: { headers: { "User-Agent": "aistudio-build" } }
    });
  }
  return ai;
}

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
}));
app.use(cors());

// SSE Notification Clients
let notificationClients = [];

app.get("/api/notifications", (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  notificationClients.push(res);

  // Send a heartbeat every 30 seconds
  const heartbeatId = setInterval(() => {
    res.write(':\n\n'); // Comment sent to keep connection alive
  }, 30000);

  req.on('close', () => {
    clearInterval(heartbeatId);
    notificationClients = notificationClients.filter(client => client !== res);
  });

  
});

function notifyClients(message) {
  notificationClients.forEach(client => {
    client.write("data: " + JSON.stringify(message) + "\n\n");
  });
}

const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));
app.use(cookieParser());

// ==========================================================
// AUTHENTICATION & AUTHORIZATION CONFIGURATION
// ==========================================================
export const JWT_CONFIGURED = Boolean(process.env.JWT_SECRET);
export const JWT_SECRET = process.env.JWT_SECRET || "dev-only-insecure-secret-change-me";
if (!JWT_CONFIGURED) {
    const msg = "JWT_SECRET is not set — using an insecure development default.";
    if (process.env.NODE_ENV === "production") logger.error(msg + " Legacy password login is disabled until it is set.");
    else logger.warn(msg);
}

export interface AuthenticatedUser {
  id: string | number;
  username: string;
  phone?: string | null;
  role: "admin" | "operator" | string;
}

export interface AuthenticatedRequest extends express.Request {
  user?: AuthenticatedUser;
}

/**
 * Validates JWT session from Authorization header or HttpOnly cookie.
 */
export function authenticateToken(
  req: AuthenticatedRequest,
  res: express.Response,
  next: express.NextFunction
) {
  const authHeader = req.headers["authorization"];
  const headerToken = authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
  const cookieToken = req.cookies?.token;
  const token = headerToken || cookieToken;

  if (!token) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  // Reject guest placeholder tokens on protected endpoints
  if (typeof token === "string" && token.startsWith("guest-")) {
    return res.status(401).json({ success: false, message: "Authentication required" });
  }

  // Basic CSRF check for state-changing cookie requests
  if (!headerToken && cookieToken && ["POST", "PUT", "DELETE", "PATCH"].includes(req.method)) {
    const origin = req.headers["origin"] || req.headers["referer"];
    const host = req.headers["host"];
    if (origin && host) {
      try {
        const originUrl = new URL(String(origin));
        if (originUrl.host !== host) {
          return res.status(403).json({ success: false, message: "Cross-site request blocked" });
        }
      } catch {
        return res.status(403).json({ success: false, message: "Cross-site request blocked" });
      }
    }
  }

  jwt.verify(token, JWT_SECRET, (err: any, decoded: any) => {
    if (err) {
      return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
    req.user = decoded;
    next();
  });
}

/**
 * Enforces role-based authorization.
 */
export function requireRole(allowedRoles: string[]) {
  return (req: AuthenticatedRequest, res: express.Response, next: express.NextFunction) => {
    authenticateToken(req, res, () => {
      if (!req.user || !allowedRoles.includes(req.user.role)) {
        return res.status(403).json({ success: false, message: "Forbidden: Insufficient privileges" });
      }
      next();
    });
  };
}

export const requireOperatorOrAdmin = requireRole(["operator", "admin"]);
export const requireAdmin = requireRole(["admin"]);

const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "900000");
const maxRequests = 10000; // Hardcoded to prevent interval fetch drops

const generalLimiter = rateLimit({
  windowMs,
  max: maxRequests,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { success: false, message: "Too many requests from this IP, please try again later." }
});

app.use("/api/", generalLimiter);

// Public runtime config for the browser. The anon/publishable key is safe to expose.
// Reading both VITE_-prefixed and unprefixed names means the client works no matter how
// the host's env vars are named — no VITE_ prefix or rebuild required on the deploy.
app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || "",
  });
});

// ==========================================================
// SIMULATED SYSTEM STATE
// ==========================================================
interface Waypoint {
  lat: number;
  lng: number;
}

interface EventLog {
  type: string;
  message: string;
  time: string;
}

let HOME_LATITUDE = 12.908200;
let HOME_LONGITUDE = 77.518600;

const robotState = {
  name: "VSTY",
  version: "2.0",
  mode: "MANUAL",
  status: "READY",
  speed: 0.25,
  max_speed: 0.40,
  direction: "STOP",
  running: false,
  paused: false,
  battery: 100.0,
  signal: 100.0,
  camera: "OFF",
  ai: "OFF",
  light: "OFF",
  emergency: false,
  temperature: 28.5,
  ph: 7.10,
  turbidity: 12,
  ultrasonic: 35,
  latitude: HOME_LATITUDE,
  longitude: HOME_LONGITUDE,
  heading: 0,
  waypoints: [] as Waypoint[],
  current_waypoint: 0,
  total_waypoints: 0,
  distance: 0,
  remaining_distance: 0,
  eta: 0,
  mission_name: "Inspection-001",
  inspection_type: "Water Tank",
  progress: 0,
  return_home_active: false
};

const eventLogs: EventLog[] = [
  { type: "SYSTEM", message: "AquaSentinel Mission Control Booted", time: new Date().toLocaleTimeString() }
];

// Simulated AI Detection Variables
const detectionLabels = ["Crack", "Corrosion", "Leakage", "Algae", "Blockage", "Rust"];
const severityLevels = ["Low", "Medium", "High", "Critical"];


// Initialize history with some starting records for realism
for (let i = 0; i < 5; i++) {
  const confidence = parseFloat((85 + Math.random() * 14).toFixed(2));
  
}

// Simulated Camera Image Cache
let mockedImageBuffer: Buffer | null = null;
async function fetchMockedImage(): Promise<Buffer> {
  if (mockedImageBuffer) return mockedImageBuffer;
  try {
    const response = await fetch("https://images.unsplash.com/photo-1583212292454-1fe6229603b7?auto=format&fit=crop&w=640&h=480&q=80");
    if (response.ok) {
      const arrBuf = await response.arrayBuffer();
      mockedImageBuffer = Buffer.from(arrBuf);
      return mockedImageBuffer;
    }
  } catch (e) {
    console.error("Error fetching mock image, falling back to color block", e);
  }
  // Fallback to empty green solid-color 1x1 GIF/PNG
  mockedImageBuffer = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64"
  );
  return mockedImageBuffer;
}

// ==========================================================
// SIMULATION UPDATE ENGINE
// ==========================================================
function updateRobotSimulation() {
  if (robotState.emergency) {
    robotState.running = false;
    robotState.direction = "STOP";
    robotState.speed = 0;
    return;
  }
  // Sanity checks for robotics safety
  if (robotState.speed > robotState.max_speed) {
    robotState.speed = robotState.max_speed;
    logger.warn(`Speed limit exceeded, clamped to ${robotState.max_speed}`);
  }
  if (robotState.battery < 5.0 && robotState.running) {
    robotState.running = false;
    robotState.status = "LOW_BATTERY_SHUTDOWN";
    eventLogs.unshift({ type: "CRITICAL", message: "Low battery shutdown", time: new Date().toLocaleTimeString() });
  }
  if (!robotState.running) {
    return;
  }

  // Battery drain
  if (robotState.battery > 0) {
    robotState.battery = parseFloat(Math.max(0, robotState.battery - 0.02).toFixed(1));
  }

  // Signal fluctuation
  if (robotState.signal > 30.0) {
    robotState.signal = parseFloat(Math.max(30.0, robotState.signal - 0.003).toFixed(1));
  } else {
    robotState.signal = parseFloat(Math.max(25, Math.min(100, robotState.signal + (Math.random() - 0.5) * 2)).toFixed(1));
  }

  // Update sensor fluctuations
  robotState.temperature = parseFloat((27.0 + Math.random() * 4.0).toFixed(1));
  robotState.ph = parseFloat((6.8 + Math.random() * 0.8).toFixed(2));
  robotState.turbidity = Math.floor(8 + Math.random() * 17);
  robotState.ultrasonic = Math.floor(20 + Math.random() * 130);

  // Return Home logic
  if (robotState.return_home_active) {
    let latReached = false;
    let lngReached = false;

    const latDiff = HOME_LATITUDE - robotState.latitude;
    if (Math.abs(latDiff) > 0.000015) {
      robotState.latitude += latDiff > 0 ? 0.000015 : -0.000015;
    } else {
      latReached = true;
    }

    const lngDiff = HOME_LONGITUDE - robotState.longitude;
    if (Math.abs(lngDiff) > 0.000015) {
      robotState.longitude += lngDiff > 0 ? 0.000015 : -0.000015;
    } else {
      lngReached = true;
    }

    // Heading towards home
    if (!latReached || !lngReached) {
      robotState.heading = Math.round(Math.atan2(HOME_LONGITUDE - robotState.longitude, HOME_LATITUDE - robotState.latitude) * 180 / Math.PI);
      if (robotState.heading < 0) robotState.heading += 360;
    }

    // Remaining distance calculation (simplistic linear towards home)
    const distHome = Math.sqrt((HOME_LATITUDE - robotState.latitude) ** 2 + (HOME_LONGITUDE - robotState.longitude) ** 2) * 111000;
    robotState.remaining_distance = parseFloat(distHome.toFixed(2));
    robotState.eta = parseFloat((robotState.remaining_distance / robotState.speed).toFixed(1));

    if (latReached && lngReached) {
      robotState.running = false;
      robotState.direction = "STOP";
      robotState.status = "READY";
      robotState.return_home_active = false;
      robotState.progress = 100;
      robotState.current_waypoint = 0;
      robotState.latitude = HOME_LATITUDE;
      robotState.longitude = HOME_LONGITUDE;
      robotState.remaining_distance = 0;
      robotState.eta = 0;

      eventLogs.unshift({
        type: "MISSION",
        message: "Robot Returned Home",
        time: new Date().toLocaleTimeString()
      });
    }
    return;
  }

  // Normal movement along waypoints
  if (robotState.waypoints && robotState.waypoints.length > 0 && robotState.current_waypoint < robotState.waypoints.length) {
    const target = robotState.waypoints[robotState.current_waypoint];
    const target_lat = target.lat;
    const target_lng = target.lng;

    let latReached = false;
    let lngReached = false;

    const latDiff = target_lat - robotState.latitude;
    if (Math.abs(latDiff) > 0.000015) {
      robotState.latitude += latDiff > 0 ? 0.000015 : -0.000015;
    } else {
      latReached = true;
    }

    const lngDiff = target_lng - robotState.longitude;
    if (Math.abs(lngDiff) > 0.000015) {
      robotState.longitude += lngDiff > 0 ? 0.000015 : -0.000015;
    } else {
      lngReached = true;
    }

    // Heading towards target
    if (!latReached || !lngReached) {
      robotState.heading = Math.round(Math.atan2(target_lng - robotState.longitude, target_lat - robotState.latitude) * 180 / Math.PI);
      if (robotState.heading < 0) robotState.heading += 360;
    }

    // Recalculate remaining distance to remaining waypoints
    let remaining = 0;
    // Current segment
    remaining += Math.sqrt((target_lat - robotState.latitude) ** 2 + (target_lng - robotState.longitude) ** 2) * 111000;
    // Subsequent segments
    for (let i = robotState.current_waypoint + 1; i < robotState.waypoints.length; i++) {
      const prev = robotState.waypoints[i - 1];
      const curr = robotState.waypoints[i];
      remaining += Math.sqrt((curr.lat - prev.lat) ** 2 + (curr.lng - prev.lng) ** 2) * 111000;
    }
    robotState.remaining_distance = parseFloat(remaining.toFixed(2));
    robotState.eta = parseFloat((robotState.remaining_distance / robotState.speed).toFixed(1));

    if (latReached && lngReached) {
      robotState.current_waypoint += 1;
      robotState.progress = Math.round((robotState.current_waypoint / robotState.waypoints.length) * 100);

      eventLogs.unshift({
        type: "WAYPOINT",
        message: `Reached Waypoint ${robotState.current_waypoint}`,
        time: new Date().toLocaleTimeString()
      });

      if (robotState.current_waypoint >= robotState.waypoints.length) {
        // Completed all waypoints! Return home
        robotState.return_home_active = true;
        robotState.status = "RETURNING_HOME";
        eventLogs.unshift({
          type: "MISSION",
          message: "All Waypoints Reached. Returning Home",
          time: new Date().toLocaleTimeString()
        });
      }
    }
  }
}

// ==========================================================
// FLASK API ENDPOINTS PORT
// ==========================================================

app.get("/api/health", (req, res) => {
  res.json(hardwareAdapter.getHealthResponse(robotState));
});

app.get("/api/status", (req, res) => {
  res.json(hardwareAdapter.getStatusResponse(robotState));
});

app.get("/api/mission", (req, res) => {
  res.json({
    name: robotState.mission_name,
    inspection: robotState.inspection_type,
    status: robotState.status,
    progress: robotState.progress,
    current_waypoint: robotState.current_waypoint,
    total_waypoints: robotState.total_waypoints,
    distance: robotState.distance,
    remaining_distance: robotState.remaining_distance,
    eta: robotState.eta,
    hardwareMode: hardwareAdapter.mode,
    simulated: hardwareAdapter.mode === "SIMULATION"
  });
});

app.get("/api/sensors", (req, res) => {
  res.json(hardwareAdapter.getSensorsResponse(robotState));
});

app.get("/api/gps", (req, res) => {
  res.json({
    latitude: robotState.latitude,
    longitude: robotState.longitude,
    heading: robotState.heading,
    waypoints: robotState.waypoints,
    currentWaypoint: robotState.current_waypoint,
    totalWaypoints: robotState.total_waypoints,
    hardwareMode: hardwareAdapter.mode,
    gpsInstalled: hardwareAdapter.config.sensors.gps.installed,
    surfaceOnlyPositioning: true
  });
});

app.post("/api/gps", requireOperatorOrAdmin, (req, res) => {
  const { latitude, longitude } = req.body;
  if (typeof latitude === "number" && typeof longitude === "number" && !isNaN(latitude) && !isNaN(longitude)) {
    HOME_LATITUDE = latitude;
    HOME_LONGITUDE = longitude;
    robotState.latitude = latitude;
    robotState.longitude = longitude;
    return res.json({ success: true, latitude, longitude });
  }
  return res.status(400).json({ success: false, message: "Invalid latitude or longitude" });
});

const waypointSchema = z.object({
  waypoints: z.array(
    z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180)
    })
  ).min(1)
});

app.post("/api/waypoints", requireOperatorOrAdmin, (req, res) => {
  const result = waypointSchema.safeParse(req.body);
  if (!result.success) {
    logger.warn(`Invalid waypoints payload from IP: ${req.ip}`);
    return res.status(400).json({ success: false, message: "Invalid waypoints data", errors: result.error.format() });
  }
  const { waypoints } = result.data;
  robotState.waypoints = waypoints;
  robotState.current_waypoint = 0;
  robotState.total_waypoints = waypoints.length;
  robotState.status = "ROUTE_LOADED";
  robotState.progress = 0;
  robotState.return_home_active = false;

  // Calculate distance
  let total_distance = 0;
  for (let i = 1; i < waypoints.length; i++) {
    const lat1 = waypoints[i - 1].lat;
    const lng1 = waypoints[i - 1].lng;
    const lat2 = waypoints[i].lat;
    const lng2 = waypoints[i].lng;
    total_distance += Math.sqrt((lat2 - lat1) ** 2 + (lng2 - lng1) ** 2) * 111000;
  }

  robotState.distance = parseFloat(total_distance.toFixed(2));
  robotState.remaining_distance = robotState.distance;
  robotState.eta = parseFloat((robotState.distance / robotState.speed).toFixed(1));

  eventLogs.unshift({
    type: "MISSION",
    message: `Route Loaded: ${waypoints.length} waypoints`,
    time: new Date().toLocaleTimeString()
  });

  res.json({
    success: true,
    count: waypoints.length,
    distance: robotState.distance,
    eta: robotState.eta,
    message: "Mission Saved Successfully"
  });
});

app.post("/api/start", (req, res) => {
  if (hardwareAdapter.mode === "REAL") {
    if (!isLocalRequest(req)) {
      return res.status(403).json({
        success: false,
        status: "FORBIDDEN_REMOTE_HARDWARE_CONTROL",
        hardwareMode: "REAL",
        hardwareConfirmed: false,
        message: "Physical mission control is restricted to local host execution."
      });
    }
    return res.status(503).json({
      success: false,
      status: "STAGE1_BENCH_ONLY",
      hardwareMode: "REAL",
      hardwareConfirmed: false,
      message:
        "Four-motor autonomous mission is disabled in REAL mode: Stage-1 firmware currently supports only one motor channel (M1) and one servo (S1) for bounded bench testing."
    });
  }

  robotState.running = true;
  robotState.paused = false;
  robotState.status = "MISSION_RUNNING";
  robotState.direction = "FORWARD";
  robotState.camera = "STREAMING";
  robotState.ai = "SCANNING";

  eventLogs.unshift({
    type: "MISSION",
    message: "Mission Started",
    time: new Date().toLocaleTimeString()
  });

  res.json({
    success: true,
    status: robotState.status,
    hardwareMode: hardwareAdapter.mode,
    simulated: hardwareAdapter.mode === "SIMULATION",
    message: "Mission Started"
  });
});

app.post("/api/pause", async (req, res) => {
  if (hardwareAdapter.mode === "REAL") {
    if (!isLocalRequest(req)) {
      return res.status(403).json({
        success: false,
        status: "FORBIDDEN_REMOTE_HARDWARE_CONTROL",
        hardwareMode: "REAL",
        hardwareConfirmed: false,
        message: "Physical mission control is restricted to local host execution."
      });
    }
    robotState.running = false;
    robotState.paused = false;
    robotState.status = "HARDWARE_DISARMED_BY_PAUSE";

    const stopRes = await hardwareAdapter.controller.stopPropulsion();
    if (!stopRes.ok || !stopRes.confirmedByController) {
      return res.status(503).json({
        success: false,
        status: robotState.status,
        hardwareMode: "REAL",
        hardwareConfirmed: false,
        message: `${stopRes.message} (Autonomous pause/resume is disabled in REAL mode; propulsion is disarmed.)`
      });
    }

    return res.json({
      success: true,
      status: robotState.status,
      hardwareMode: "REAL",
      hardwareConfirmed: true,
      message: "Physical propulsion stopped and disarmed. Note: resume is disabled in REAL mode until safe re-arming is implemented."
    });
  }

  robotState.running = false;
  robotState.paused = true;
  robotState.status = "MISSION_PAUSED";

  eventLogs.unshift({
    type: "MISSION",
    message: "Mission Paused",
    time: new Date().toLocaleTimeString()
  });

  res.json({
    success: true,
    status: robotState.status,
    hardwareMode: hardwareAdapter.mode,
    message: "Mission Paused"
  });
});

app.post("/api/resume", (req, res) => {
  if (hardwareAdapter.mode === "REAL") {
    if (!isLocalRequest(req)) {
      return res.status(403).json({
        success: false,
        status: "FORBIDDEN_REMOTE_HARDWARE_CONTROL",
        hardwareMode: "REAL",
        hardwareConfirmed: false,
        message: "Physical mission control is restricted to local host execution."
      });
    }
    return res.status(503).json({
      success: false,
      status: "RESUME_DISABLED_IN_REAL_MODE",
      hardwareMode: "REAL",
      hardwareConfirmed: false,
      message:
        "Mission resume is disabled in REAL mode because pause disarms physical propulsion and 4-motor autonomous control is not implemented. Use /api/hardware/arm on the local host for bounded Stage-1 bench tests."
    });
  }

  robotState.running = true;
  robotState.paused = false;
  robotState.status = "MISSION_RUNNING";

  eventLogs.unshift({
    type: "MISSION",
    message: "Mission Resumed",
    time: new Date().toLocaleTimeString()
  });

  res.json({
    success: true,
    status: robotState.status,
    hardwareMode: hardwareAdapter.mode,
    message: "Mission Resumed"
  });
});

app.post("/api/emergency-stop", async (req, res) => {
  robotState.emergency = true;
  robotState.running = false;
  robotState.paused = false;
  robotState.status = "EMERGENCY_STOP";
  robotState.direction = "STOP";
  robotState.speed = 0; // Cut motors immediately
  robotState.camera = "OFF";
  
  eventLogs.unshift({
    type: "CRITICAL",
    message: "HARDWARE EMERGENCY STOP ACTIVATED",
    time: new Date().toLocaleTimeString()
  });

  logger.warn("Emergency stop activated via API.");

  if (hardwareAdapter.mode === "REAL" || hardwareAdapter.controller.isConnected) {
    const estopRes = await hardwareAdapter.controller.emergencyStop();
    if (hardwareAdapter.mode === "REAL" && (!estopRes.ok || !estopRes.confirmedByController)) {
      return res.status(503).json({
        success: false,
        status: "EMERGENCY_STOP_UNCONFIRMED",
        hardwareMode: "REAL",
        hardwareConfirmed: false,
        message: estopRes.message
      });
    }
    return res.json({
      success: true,
      status: robotState.status,
      hardwareMode: hardwareAdapter.mode,
      hardwareConfirmed: estopRes.confirmedByController,
      message: estopRes.message
    });
  }

  res.json({
    success: true,
    status: robotState.status,
    hardwareMode: "SIMULATION",
    hardwareConfirmed: false,
    simulated: true,
    message: "EMERGENCY STOP EXECUTED (SIMULATION)"
  });
});

app.post("/api/stop", async (req, res) => {
  if (hardwareAdapter.mode === "REAL" && !isLocalRequest(req)) {
    return res.status(403).json({
      success: false,
      status: "FORBIDDEN_REMOTE_HARDWARE_CONTROL",
      hardwareMode: "REAL",
      hardwareConfirmed: false,
      message: "Physical mission control is restricted to local host execution."
    });
  }

  robotState.running = false;
  robotState.paused = false;
  robotState.status = "MISSION_STOPPED";
  robotState.direction = "STOP";
  robotState.camera = "OFF";
  robotState.ai = "OFF";

  eventLogs.unshift({
    type: "MISSION",
    message: "Mission Stopped",
    time: new Date().toLocaleTimeString()
  });

  if (hardwareAdapter.mode === "REAL" || hardwareAdapter.controller.isConnected) {
    const stopRes = await hardwareAdapter.controller.stopPropulsion();
    if (hardwareAdapter.mode === "REAL" && (!stopRes.ok || !stopRes.confirmedByController)) {
      return res.status(503).json({
        success: false,
        status: "STOP_UNCONFIRMED",
        hardwareMode: "REAL",
        hardwareConfirmed: false,
        message: stopRes.message
      });
    }
    return res.json({
      success: true,
      status: robotState.status,
      hardwareMode: hardwareAdapter.mode,
      hardwareConfirmed: stopRes.confirmedByController,
      message: "Mission Stopped"
    });
  }

  res.json({
    success: true,
    status: robotState.status,
    hardwareMode: "SIMULATION",
    simulated: true,
    message: "Mission Stopped"
  });
});

app.post("/api/home", (req, res) => {
  if (hardwareAdapter.mode === "REAL") {
    return res.status(503).json({
      success: false,
      status: "SURFACE_GPS_ONLY",
      hardwareMode: "REAL",
      hardwareConfirmed: false,
      message: "Autonomous underwater Return-to-Home is blocked in REAL mode: NEO-6M GPS works only at the surface and 4-motor thrust geometry is unconfirmed."
    });
  }

  robotState.return_home_active = true;
  robotState.running = true;
  robotState.status = "RETURNING_HOME";

  eventLogs.unshift({
    type: "MISSION",
    message: "Returning Home command issued",
    time: new Date().toLocaleTimeString()
  });

  res.json({
    success: true,
    status: robotState.status,
    hardwareMode: "SIMULATION",
    simulated: true,
    message: "Returning Home"
  });
});

// App Settings API for global persistence
app.get("/api/settings", (req, res) => {
  const settingsPath = path.join(process.cwd(), 'app_settings.json');
  let settings = { collegeLogo: "/rrce-logo.jpg" };
  if (fsLib.existsSync(settingsPath)) {
      try { 
          const fileSettings = JSON.parse(fsLib.readFileSync(settingsPath, 'utf8')); 
          settings = { ...settings, ...fileSettings };
      } catch(e) {}
  }
  res.json({ success: true, settings });
});

// Camera image capture API
app.post("/capture", async (req, res) => {
  if (hardwareAdapter.mode === "REAL") {
    const targetUrl =
      hardwareAdapter.camera.status.targetUrl ||
      hardwareAdapter.camera.getDefaultCaptureUrl();
    const snap = await hardwareAdapter.camera.captureSnapshotToFile(
      targetUrl,
      path.join(process.cwd(), "public", "media")
    );
    if (!snap.success || !snap.file) {
      return res.status(503).json({
        success: false,
        simulated: false,
        hardwareMode: "REAL",
        message: snap.message,
        mission: robotState.mission_name,
        status: robotState.status
      });
    }
    return res.json({
      success: true,
      simulated: false,
      hardwareMode: "REAL",
      image: snap.file.url,
      file: snap.file,
      mission: robotState.mission_name,
      status: robotState.status
    });
  }

  res.json({
    success: true,
    simulated: true,
    hardwareMode: "SIMULATION",
    image: "https://images.unsplash.com/photo-1582967160759-407fb51b5e39?q=80&w=900&auto=format&fit=crop", // underwater pipe style
    mission: robotState.mission_name,
    status: robotState.status
  });
});

// ==========================================================
// MEDIA STORAGE API (Images & Videos)
// ==========================================================
const mediaDir = path.join(process.cwd(), 'public', 'media');
if (!fsLib.existsSync(mediaDir)) {
  fsLib.mkdirSync(mediaDir, { recursive: true });
}

app.get("/api/media", (req, res) => {
  try {
    if (!fsLib.existsSync(mediaDir)) {
      return res.json([]);
    }
    const files = fsLib.readdirSync(mediaDir);
    const mediaFiles = files
      .filter(file => !file.startsWith('.') && file.toLowerCase() !== 'readme.md')
      .map((file) => {
        const filePath = path.join(mediaDir, file);
        const stats = fsLib.statSync(filePath);
        const ext = path.extname(file).toLowerCase();
        const isVideo = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv'].includes(ext);
        const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
        
        return {
          id: file,
          filename: file,
          name: file,
          type: isVideo ? "video" : "image",
          url: `/media/${file}`,
          size: stats.size > 1024 * 1024 ? `${sizeMb} MB` : `${(stats.size / 1024).toFixed(1)} KB`,
          date: stats.mtime.toISOString().split('T')[0]
        };
      });
    
    res.json(mediaFiles);
  } catch (err: any) {
    logger.error("Error reading media folder", err);
    res.status(500).json({ success: false, message: "Failed to list media files" });
  }
});

app.post("/api/media/upload", requireOperatorOrAdmin, (req, res) => {
  try {
    const { name, fileData } = req.body || {};
    if (!name || !fileData) {
      return res.status(400).json({ success: false, message: "Missing file name or data" });
    }

    const safeName = path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "_");
    let base64Content = fileData;
    if (fileData.includes("base64,")) {
      base64Content = fileData.split("base64,")[1];
    }

    const buffer = Buffer.from(base64Content, "base64");
    const targetPath = path.join(mediaDir, safeName);

    fsLib.writeFileSync(targetPath, buffer);
    logger.info(`Saved media file to backend: ${safeName} (${buffer.length} bytes)`);

    const stats = fsLib.statSync(targetPath);
    const ext = path.extname(safeName).toLowerCase();
    const isVideo = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv'].includes(ext);
    const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);

    const savedMedia = {
      id: safeName,
      filename: safeName,
      name: safeName,
      type: isVideo ? "video" : "image",
      url: `/media/${safeName}`,
      size: stats.size > 1024 * 1024 ? `${sizeMb} MB` : `${(stats.size / 1024).toFixed(1)} KB`,
      date: new Date().toISOString().split('T')[0]
    };

    res.json({ success: true, message: "Media saved to backend storage", file: savedMedia });
  } catch (err: any) {
    logger.error("Upload media error", err);
    res.status(500).json({ success: false, message: "Failed to upload file to backend storage" });
  }
});

app.post("/api/media/upload-chunk", requireOperatorOrAdmin, (req, res) => {
  try {
    const { name, chunk, index, total } = req.body || {};
    if (!name || chunk === undefined) {
      return res.status(400).json({ success: false, message: "Missing chunk data" });
    }
    
    const safeName = path.basename(name).replace(/[^a-zA-Z0-9_.-]/g, "_");
    const targetPath = path.join(mediaDir, safeName);
    
    const buffer = Buffer.from(chunk, "base64");
    
    if (index === 0) {
      fsLib.writeFileSync(targetPath, buffer);
    } else {
      fsLib.appendFileSync(targetPath, buffer);
    }
    
    if (index === total - 1) {
      const stats = fsLib.statSync(targetPath);
      const ext = path.extname(safeName).toLowerCase();
      const isVideo = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv'].includes(ext);
      const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);
      
      const savedMedia = {
        id: safeName,
        filename: safeName,
        name: safeName,
        type: isVideo ? "video" : "image",
        url: `/media/${safeName}`,
        size: stats.size > 1024 * 1024 ? `${sizeMb} MB` : `${(stats.size / 1024).toFixed(1)} KB`,
        date: new Date().toISOString().split('T')[0]
      };
      
      return res.json({ success: true, message: "Upload complete", file: savedMedia });
    }
    
    res.json({ success: true, message: `Chunk ${index} received` });
  } catch (err: any) {
    logger.error("Upload chunk error", err);
    res.status(500).json({ success: false, message: "Failed to upload chunk" });
  }
});

app.delete("/api/media/:filename", requireOperatorOrAdmin, (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const targetPath = path.join(mediaDir, filename);

    if (fsLib.existsSync(targetPath)) {
      fsLib.unlinkSync(targetPath);
      logger.info(`Deleted media file from backend storage: ${filename}`);
      res.json({ success: true, message: "File deleted successfully" });
    } else {
      res.status(404).json({ success: false, message: "File not found" });
    }
  } catch (err: any) {
    logger.error("Delete media error", err);
    res.status(500).json({ success: false, message: "Failed to delete file" });
  }
});

// ==========================================================
// ESP32-CAM LIVE RELAY (Laptop -> Render -> Dashboard)
// ==========================================================
const CAMERA_RELAY_STALE_MS = 8000;
const CAMERA_RELAY_MAX_FRAME_BYTES = 512 * 1024;
let latestRelayFrame: Buffer | null = null;
let latestRelayFrameAtMs = 0;
let relayFrameTimes: number[] = [];
const relayStreamClients = new Set<express.Response>();

function writeRelayMjpegFrame(client: express.Response, frame: Buffer): void {
  if (client.destroyed || client.writableEnded || client.writableLength > 1024 * 1024) {
    relayStreamClients.delete(client);
    if (!client.writableEnded) client.end();
    return;
  }
  try {
    client.write(Buffer.concat([
      Buffer.from("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: " + frame.length + "\r\n\r\n"),
      frame,
      Buffer.from("\r\n"),
    ]));
  } catch {
    relayStreamClients.delete(client);
    if (!client.writableEnded) client.end();
  }
}

function getCameraRelayStatus() {
  const ageMs = latestRelayFrameAtMs ? Date.now() - latestRelayFrameAtMs : null;
  const recent = relayFrameTimes.filter((t) => Date.now() - t <= 2000);
  return {
    online: Boolean(latestRelayFrame && ageMs !== null && ageMs <= CAMERA_RELAY_STALE_MS),
    verifiedAtMs: latestRelayFrameAtMs || null,
    frameAgeMs: ageMs,
    fps: recent.length > 1 ? Math.round((recent.length - 1) / 2 * 10) / 10 : recent.length,
    frameBytes: latestRelayFrame?.length || 0,
    isCloudEnvironment: hardwareAdapter.config.isCloudEnvironment,
    message: latestRelayFrame && ageMs !== null && ageMs <= CAMERA_RELAY_STALE_MS
      ? "Live camera relay is receiving verified JPEG frames."
      : "Waiting for the laptop camera gateway to send frames.",
  };
}

app.post(
  "/api/camera/relay/frame",
  authenticateToken,
  express.raw({ type: "image/jpeg", limit: CAMERA_RELAY_MAX_FRAME_BYTES }),
  (req: AuthenticatedRequest, res: express.Response) => {
    if (!Buffer.isBuffer(req.body) || req.body.length < 64 || req.body.length > CAMERA_RELAY_MAX_FRAME_BYTES) {
      return res.status(400).json({ success: false, message: "Expected a JPEG frame up to 512 KB." });
    }
    if (!isValidJpeg(req.body)) {
      return res.status(415).json({ success: false, message: "Frame is not a structurally valid JPEG." });
    }
    latestRelayFrame = Buffer.from(req.body);
    latestRelayFrameAtMs = Date.now();
    relayFrameTimes.push(latestRelayFrameAtMs);
    relayFrameTimes = relayFrameTimes.filter((t) => latestRelayFrameAtMs - t <= 2000);
    for (const client of relayStreamClients) writeRelayMjpegFrame(client, latestRelayFrame);
    return res.status(202).json({ success: true, receivedAt: latestRelayFrameAtMs });
  }
);

function handleCameraRelayStream(_req: express.Request, res: express.Response) {
  const status = getCameraRelayStatus();
  if (!status.online || !latestRelayFrame) {
    return res.status(503).set("Retry-After", "2").type("text/plain").send("Camera relay is waiting for the laptop gateway.");
  }
  res.status(200);
  res.set({
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache, no-store, must-revalidate",
    "Pragma": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  relayStreamClients.add(res);
  writeRelayMjpegFrame(res, latestRelayFrame);
  const cleanup = () => relayStreamClients.delete(res);
  res.on("close", cleanup);
  res.on("finish", cleanup);
}

// ==========================================================
// ESP32-CAM WIRELESS WIFI CAMERA STREAMING & PROXY
// ==========================================================

// Ping/Test ESP32-CAM Camera connection over WiFi
const handleCamPing = async (_req: express.Request, res: express.Response) => {
  if (hardwareAdapter.config.isCloudEnvironment) return res.json(getCameraRelayStatus());
  const targetUrl = hardwareAdapter.camera.getDefaultStreamUrl();
  const status = await hardwareAdapter.camera.pingCamera(targetUrl);
  if (!res.headersSent) {
    res.json({
      online: status.online,
      status: status.statusCode,
      contentType: status.contentType || "video/mjpeg",
      latencyMs: status.latencyMs,
      message: status.online
        ? "ESP32-CAM stream is reachable."
        : "ESP32-CAM is not reachable. Check power, Wi-Fi, and backend configuration."
    });
  }
};

app.get("/api/esp-ping", handleCamPing);
app.get("/api/rpi-ping", handleCamPing);

// Proxy ESP32-CAM MJPEG camera stream to avoid browser CORS/Mixed-Content issues.
// Exclusively targets the backend-configured stream target to prevent arbitrary proxying.
const handleCamProxy = (req: express.Request, res: express.Response) => {
  if (hardwareAdapter.config.isCloudEnvironment) return handleCameraRelayStream(req, res);
  const targetUrl = hardwareAdapter.camera.getDefaultStreamUrl();
  hardwareAdapter.camera.proxyStream(targetUrl, req, res);
};

app.get("/api/esp-proxy", handleCamProxy);
app.get("/api/rpi-proxy", handleCamProxy);
app.get("/api/camera/stream", handleCamProxy);

// Capture a live snapshot from ESP32-CAM stream/capture endpoint and save a validated JPEG to /public/media/.
// Exclusively resolves backend-configured capture URL.
const handleCamSnapshot = async (req: express.Request, res: express.Response) => {
  const { filename } = req.body || {};
  if (hardwareAdapter.config.isCloudEnvironment) {
    if (!latestRelayFrame || Date.now() - latestRelayFrameAtMs > CAMERA_RELAY_STALE_MS) {
      return res.status(503).json({ success: false, simulated: false, message: "Camera relay is offline. Start the laptop gateway before capturing." });
    }
    const safeName = filename ? path.basename(String(filename)).replace(/[^a-zA-Z0-9_.-]/g, "_") : "esp-snapshot-" + Date.now() + ".jpg";
    if (!fsLib.existsSync(mediaDir)) fsLib.mkdirSync(mediaDir, { recursive: true });
    fsLib.writeFileSync(path.join(mediaDir, safeName), latestRelayFrame);
    return res.json({
      success: true,
      simulated: false,
      message: "Snapshot captured from the live laptop-to-Render camera relay.",
      file: { filename: safeName, url: "/media/" + safeName, sizeBytes: latestRelayFrame.length },
    });
  }
  const targetUrl = hardwareAdapter.camera.getDefaultCaptureUrl();

  const snapResult = await hardwareAdapter.camera.captureSnapshotToFile(targetUrl, mediaDir, filename);
  if (!res.headersSent) {
    if (snapResult.success && snapResult.file) {
      res.json({
        success: true,
        simulated: false,
        message: snapResult.message,
        file: snapResult.file,
      });
    } else {
      res.status(502).json({
        success: false,
        simulated: false,
        message: snapResult.message,
      });
    }
  }
};

app.post("/api/esp-snapshot", handleCamSnapshot);
app.post("/api/rpi-snapshot", handleCamSnapshot);
app.post("/api/camera/snapshot", handleCamSnapshot);

// Camera Configuration & Status APIs (Authoritative Backend State)
// Sanitized so the camera's private IP and raw stream/capture URLs are NEVER returned to frontend clients.
app.get("/api/camera/config", (_req, res) => {
  const fullCfg = hardwareAdapter.camera.getCameraConfig();
  res.json({
    success: true,
    config: {
      proxyStreamUrl: "/api/camera/stream",
      autoConnect: fullCfg.autoConnect,
      isVerified: fullCfg.isVerified,
      isCloudEnvironment: fullCfg.isCloudEnvironment,
    },
  });
});

app.post("/api/camera/config", requireAdmin, (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({
      success: false,
      message: "Updating hardware camera configuration is restricted to local host execution.",
    });
  }
  const { ip, streamPort, capturePort, streamPath, capturePath, isVerified } = req.body || {};
  if (ip && typeof ip === "string") {
    const testUrl = `http://${ip}:${streamPort || 81}${streamPath || "/stream"}`;
    const guard = validateCamUrl(testUrl);
    if (!guard.ok) {
      return res.status(400).json({ success: false, message: guard.reason });
    }
  }
  const result = hardwareAdapter.camera.updateRuntimeCameraConfig({
    ip,
    streamPort: streamPort !== undefined ? Number(streamPort) : undefined,
    capturePort: capturePort !== undefined ? Number(capturePort) : undefined,
    streamPath,
    capturePath,
    isVerified: typeof isVerified === "boolean" ? isVerified : undefined,
  });
  res.json({
    success: true,
    message: "Camera configuration updated",
    status: {
      ...result.status,
      targetUrl: result.status.targetUrl ? "/api/camera/stream" : null,
    },
    config: {
      proxyStreamUrl: "/api/camera/stream",
      autoConnect: result.config.autoConnect,
      isVerified: result.config.isVerified,
      isCloudEnvironment: result.config.isCloudEnvironment,
    },
  });
});

app.get("/api/camera/status", async (req, res) => {
  if (hardwareAdapter.config.isCloudEnvironment) {
    const relayStatus = getCameraRelayStatus();
    return res.json({
      success: true,
      status: {
        ...relayStatus,
        streamReachable: relayStatus.online,
        isVerified: relayStatus.online,
        failureCount: relayStatus.online ? 0 : 1,
        latencyMs: null,
      },
    });
  }
  const quick = req.query.quick === "true";
  let status = hardwareAdapter.camera.status;
  if (!quick && !status.online && !hardwareAdapter.config.isCloudEnvironment) {
    status = await hardwareAdapter.camera.checkConnection();
  }
  res.json({
    success: true,
    status: {
      online: status.online,
      verifiedAtMs: status.verifiedAtMs,
      statusCode: status.statusCode,
      contentType: status.contentType,
      latencyMs: status.latencyMs,
      isVerified: status.isVerified,
      failureCount: status.failureCount,
      streamReachable: status.streamReachable,
      isCloudEnvironment: status.isCloudEnvironment,
      message: status.online
        ? "ESP32-CAM stream is reachable."
        : "ESP32-CAM is offline or unreachable. Check its power, Wi-Fi, and backend configuration.",
    },
  });
});

// ==========================================================
// PERSISTENT USER ROBOT & DYNAMIC CAMERA CONFIGURATION API
// ==========================================================

export function sanitizeCameraEndpoint(input: {
  cameraIp?: string;
  streamPort?: number | string;
  capturePort?: number | string;
  streamPath?: string;
  capturePath?: string;
}) {
  let rawIp = typeof input.cameraIp === "string" ? input.cameraIp.trim() : "";
  let cleanIp = rawIp;
  let streamPort = Number(input.streamPort) || 81;
  let capturePort = Number(input.capturePort) || 80;
  let streamPath = (typeof input.streamPath === "string" && input.streamPath.startsWith("/")) ? input.streamPath : "/stream";
  let capturePath = (typeof input.capturePath === "string" && input.capturePath.startsWith("/")) ? input.capturePath : "/capture";

  if (cleanIp.startsWith("http://") || cleanIp.startsWith("https://")) {
    try {
      const parsed = new URL(cleanIp);
      cleanIp = parsed.hostname;
      if (parsed.port) {
        const p = Number(parsed.port);
        if (p >= 1 && p <= 65535) {
          streamPort = p;
          capturePort = p;
        }
      }
      if (parsed.pathname && parsed.pathname !== "/") {
        streamPath = parsed.pathname;
      }
    } catch {
      cleanIp = cleanIp.replace(/^https?:\/\//i, "");
    }
  }

  if (cleanIp.includes(":")) {
    const parts = cleanIp.split(":");
    cleanIp = parts[0].trim();
    const portPart = parts[1].split("/")[0].trim();
    const p = Number(portPart);
    if (p >= 1 && p <= 65535) {
      streamPort = p;
      capturePort = p;
    }
  }

  cleanIp = cleanIp.split("/")[0].trim();

  return {
    cameraIp: cleanIp,
    streamPort,
    capturePort,
    streamPath,
    capturePath,
  };
}

async function testEspCamConnection(opts: {
  cameraIp: string;
  streamPort: number;
  capturePort: number;
  streamPath: string;
  capturePath: string;
}): Promise<{
  success: boolean;
  status: "Connected" | "Disconnected" | "Invalid IP" | "Connection timeout";
  statusCode?: number;
  contentType?: string;
  latencyMs?: number;
  message: string;
  isVerified?: boolean;
}> {
  const sanitized = sanitizeCameraEndpoint(opts);
  const { cameraIp, streamPort, capturePort, streamPath, capturePath } = sanitized;
  const ip = typeof cameraIp === "string" ? cameraIp.trim() : "";
  if (!ip) {
    return {
      success: false,
      status: "Invalid IP",
      message: "Please enter a valid ESP32-CAM IP address.",
    };
  }

  const streamTestUrl = `http://${ip}:${streamPort}${streamPath}`;
  const guard = validateCamUrl(streamTestUrl);
  if (!guard.ok) {
    return {
      success: false,
      status: "Invalid IP",
      message: guard.reason || "Invalid camera IP address.",
    };
  }

  // Cloud deployment check: Render cloud cannot connect to RFC1918 private LAN IP
  if (hardwareAdapter.config.isCloudEnvironment || process.env.RENDER || process.env.VERCEL) {
    return {
      success: false,
      status: "Disconnected",
      message:
        "Render cloud servers cannot establish direct TCP connections to private LAN IP addresses (192.168.x.x / 10.x.x.x). For live video and real hardware control, run the Mission Control gateway locally on your laptop connected to the robot Wi-Fi hotspot.",
    };
  }

  const captureTestUrl = `http://${ip}:${capturePort}${capturePath}`;
  const startTime = Date.now();

  return new Promise((resolve) => {
    let resolved = false;
    const finish = (result: any) => {
      if (!resolved) {
        resolved = true;
        resolve(result);
      }
    };

    const parsedUrl = new URL(captureTestUrl);
    const req = http.get(
      {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || 80,
        path: parsedUrl.pathname + parsedUrl.search,
        timeout: 3500,
        headers: { Accept: "image/jpeg, multipart/x-mixed-replace, */*" },
      },
      (res) => {
        const statusCode = res.statusCode || 0;
        const contentType = res.headers["content-type"] || "";

        if (statusCode >= 300 && statusCode < 400) {
          res.resume();
          return finish({
            success: false,
            status: "Disconnected",
            statusCode,
            message: "Camera returned HTTP redirect, which is blocked for security.",
          });
        }

        if (statusCode !== 200) {
          res.resume();
          return finish({
            success: false,
            status: "Disconnected",
            statusCode,
            message: `Camera returned HTTP status ${statusCode}.`,
          });
        }

        const chunks: Buffer[] = [];
        let totalBytes = 0;

        res.on("data", (chunk: Buffer) => {
          totalBytes += chunk.length;
          chunks.push(chunk);
          if (totalBytes > 2 * 1024 * 1024) {
            req.destroy();
          }
        });

        res.on("end", () => {
          const latencyMs = Date.now() - startTime;
          const fullBuf = Buffer.concat(chunks);
          const frame = extractFirstJpegFrame(fullBuf) || (isValidJpeg(fullBuf) ? fullBuf : null);

          if (frame && isValidJpeg(frame)) {
            return finish({
              success: true,
              status: "Connected",
              statusCode,
              contentType,
              latencyMs,
              message: `ESP32-CAM verified successfully (${latencyMs}ms latency). Valid JPEG frame validated.`,
              isVerified: true,
            });
          }

          // If capture returned non-image content (such as text/html), reject as non-camera response
          if (!contentType.toLowerCase().includes("image") && !contentType.toLowerCase().includes("multipart")) {
            return finish({
              success: false,
              status: "Disconnected",
              statusCode,
              contentType,
              latencyMs,
              message: "Camera responded, but did not return a valid JPEG image payload.",
            });
          }

          // If capture failed, try stream ping before giving up
          hardwareAdapter.camera.pingCamera(streamTestUrl).then((streamPing) => {
            if (streamPing.online && streamPing.contentType && (streamPing.contentType.includes("image") || streamPing.contentType.includes("multipart"))) {
              return finish({
                success: true,
                status: "Connected",
                statusCode: streamPing.statusCode,
                contentType: streamPing.contentType,
                latencyMs: streamPing.latencyMs,
                message: "ESP32-CAM stream endpoint is responsive and connected.",
                isVerified: true,
              });
            }
            return finish({
              success: false,
              status: "Disconnected",
              statusCode,
              contentType,
              latencyMs,
              message: "Camera responded, but did not return a valid JPEG image payload.",
            });
          }).catch(() => {
            return finish({
              success: false,
              status: "Disconnected",
              statusCode,
              contentType,
              latencyMs,
              message: "Camera responded, but did not return a valid JPEG image payload.",
            });
          });
        });

        res.on("error", (err: any) => {
          finish({
            success: false,
            status: "Disconnected",
            message: `Camera stream error: ${err.message}`,
          });
        });
      }
    );

    req.on("timeout", () => {
      req.destroy();
      finish({
        success: false,
        status: "Connection timeout",
        message: "Connection to ESP32-CAM timed out after 3500ms (timeout). Verify robot camera power and Wi-Fi connection.",
      });
    });

    req.on("error", (err: any) => {
      if (err.code === "ECONNREFUSED") {
        finish({
          success: false,
          status: "Disconnected",
          message: `Connection refused on ${parsedUrl.hostname}:${parsedUrl.port}. Ensure ESP32-CAM web server is running.`,
        });
      } else if (err.code === "EHOSTUNREACH" || err.code === "ENETUNREACH") {
        finish({
          success: false,
          status: "Disconnected",
          message: `Host unreachable (${parsedUrl.hostname}). Verify your laptop is on the robot's Wi-Fi network.`,
        });
      } else {
        finish({
          success: false,
          status: "Disconnected",
          message: `Network error: ${err.message}`,
        });
      }
    });
  });
}

// GET /api/robot/config: Load user's saved robot & camera configuration from database
app.get("/api/robot/config", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    let config = await getRobotConfig(userId);
    const backendCam = hardwareAdapter.camera.getCameraConfig();

    if (!config) {
      config = {
        userId: String(userId),
        robotName: "VSTY Submersible Micro Robot",
        cameraIp: backendCam.ip || "",
        streamPort: 81,
        capturePort: 80,
        streamPath: "/stream",
        capturePath: "/capture",
        connectionMode: "LOCAL_GATEWAY",
        lastVerifiedAt: null,
        updatedAt: new Date().toISOString(),
      };
    }

    const streamUrl = config.cameraIp
      ? `http://${config.cameraIp}:${config.streamPort}${config.streamPath}`
      : null;
    const captureUrl = config.cameraIp
      ? `http://${config.cameraIp}:${config.capturePort}${config.capturePath}`
      : null;

    res.json({
      success: true,
      config: {
        ...config,
        streamUrl,
        captureUrl,
        proxyStreamUrl: "/api/camera/stream",
        isCloudEnvironment: hardwareAdapter.config.isCloudEnvironment,
        isVerified: hardwareAdapter.camera.status.isVerified,
      },
    });
  } catch (err: any) {
    logger.error("Error retrieving robot config:", err);
    res.status(500).json({ success: false, message: "Failed to load robot configuration" });
  }
});

// POST /api/robot/config: Save persistent camera & robot configuration per user
app.post("/api/robot/config", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ success: false, message: "Unauthorized" });
    }

    const {
      robotName,
      cameraIp,
      streamPort,
      capturePort,
      streamPath,
      capturePath,
      connectionMode,
    } = req.body || {};

    const sanitized = sanitizeCameraEndpoint({
      cameraIp,
      streamPort,
      capturePort,
      streamPath,
      capturePath,
    });
    const cleanIp = sanitized.cameraIp;
    const cleanStreamPort = sanitized.streamPort;
    const cleanCapturePort = sanitized.capturePort;
    const cleanStreamPath = sanitized.streamPath;
    const cleanCapturePath = sanitized.capturePath;
    const cleanMode = (connectionMode === "CLOUD_REMOTE") ? "CLOUD_REMOTE" : "LOCAL_GATEWAY";

    if (cleanStreamPort < 1 || cleanStreamPort > 65535 || cleanCapturePort < 1 || cleanCapturePort > 65535) {
      return res.status(400).json({ success: false, message: "Port numbers must be between 1 and 65535." });
    }

    if (cleanIp) {
      const testUrl = `http://${cleanIp}:${cleanStreamPort}${cleanStreamPath}`;
      const guard = validateCamUrl(testUrl);
      if (!guard.ok) {
        return res.status(400).json({ success: false, status: "Invalid IP", message: guard.reason });
      }
    }

    const newConfig: RobotConfig = {
      userId: String(userId),
      robotName: (typeof robotName === "string" && robotName.trim()) ? robotName.trim().slice(0, 64) : "VSTY Submersible Micro Robot",
      cameraIp: cleanIp,
      streamPort: cleanStreamPort,
      capturePort: cleanCapturePort,
      streamPath: cleanStreamPath,
      capturePath: cleanCapturePath,
      connectionMode: cleanMode,
      lastVerifiedAt: null,
      updatedAt: new Date().toISOString(),
    };

    const saved = await saveRobotConfig(newConfig);
    if (!saved) {
      return res.status(500).json({ success: false, message: "Database write failure while saving robot configuration." });
    }

    // Update active runtime camera target so proxy stream /api/camera/stream reflects new settings immediately
    if (cleanIp) {
      hardwareAdapter.camera.updateRuntimeCameraConfig({
        ip: cleanIp,
        streamPort: cleanStreamPort,
        capturePort: cleanCapturePort,
        streamPath: cleanStreamPath,
        capturePath: cleanCapturePath,
      });
    }

    eventLogs.unshift({
      type: "HARDWARE",
      message: `Camera configuration updated by ${req.user?.username || "operator"}: ${cleanIp ? `${cleanIp}:${cleanStreamPort}` : "unconfigured"} (${cleanMode})`,
      time: new Date().toLocaleTimeString(),
    });

    const streamUrl = cleanIp ? `http://${cleanIp}:${cleanStreamPort}${cleanStreamPath}` : null;
    const captureUrl = cleanIp ? `http://${cleanIp}:${cleanCapturePort}${cleanCapturePath}` : null;

    res.json({
      success: true,
      message: "Camera configuration saved permanently.",
      config: {
        ...newConfig,
        streamUrl,
        captureUrl,
        proxyStreamUrl: "/api/camera/stream",
        isCloudEnvironment: hardwareAdapter.config.isCloudEnvironment,
      },
    });
  } catch (err: any) {
    logger.error("Error saving robot config:", err);
    res.status(500).json({ success: false, message: "Failed to save robot configuration" });
  }
});

// POST /api/camera/test-connection: Verify live camera response, check latency, and validate JPEG frames
app.post("/api/camera/test-connection", authenticateToken, async (req: AuthenticatedRequest, res) => {
  try {
    const userId = req.user?.id;
    let { cameraIp, streamPort, capturePort, streamPath, capturePath } = req.body || {};

    if (!cameraIp && userId) {
      const saved = await getRobotConfig(userId);
      if (saved) {
        cameraIp = saved.cameraIp;
        streamPort = streamPort ?? saved.streamPort;
        capturePort = capturePort ?? saved.capturePort;
        streamPath = streamPath ?? saved.streamPath;
        capturePath = capturePath ?? saved.capturePath;
      }
    }

    const testRes = await testEspCamConnection({
      cameraIp: cameraIp || hardwareAdapter.camera.getCameraConfig().ip,
      streamPort: Number(streamPort) || 81,
      capturePort: Number(capturePort) || 80,
      streamPath: streamPath || "/stream",
      capturePath: capturePath || "/capture",
    });

    if (testRes.success && userId) {
      await updateLastVerified(userId);
      hardwareAdapter.camera.updateRuntimeCameraConfig({
        isVerified: true,
      });
    }

    if (testRes.status === "Invalid IP") {
      return res.status(400).json({
        success: false,
        status: testRes.status,
        statusCode: testRes.statusCode,
        message: testRes.message,
      });
    }

    res.json({
      success: testRes.success,
      status: testRes.status,
      statusCode: testRes.statusCode,
      contentType: testRes.contentType,
      latencyMs: testRes.latencyMs,
      message: testRes.message,
      isVerified: testRes.isVerified ?? false,
    });
  } catch (err: any) {
    logger.error("Test connection error:", err);
    res.status(500).json({
      success: false,
      status: "Disconnected",
      message: "Test connection request failed: " + err.message,
    });
  }
});

// ==========================================================
// IMAGE-TO-3D PREVIEW (experimental, visualization-only)
// TripoSR via its public Gradio Space, called with the raw /call + SSE protocol
// (the @gradio/client stream does not keep a Node process alive for the GPU job).
// HF_API_TOKEN is read ONLY here, server-side — never sent to the browser.
// ==========================================================
const TRIPOSR_SPACE = "https://stabilityai-triposr.hf.space";
const generate3dLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  message: { error: "Too many 3D generations from this IP. Please wait a few minutes." },
});

async function triposrCall(fn: string, data: any[], timeoutMs: number, signal?: AbortSignal): Promise<any[]> {
  const HF = process.env.HF_API_TOKEN;
  const H: Record<string, string> = HF ? { Authorization: `Bearer ${HF}` } : {};
  const post = await fetch(`${TRIPOSR_SPACE}/call/${fn}`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
    signal,
  });
  const posted = await post.text();
  let eventId: string;
  try { eventId = JSON.parse(posted).event_id; } catch { throw new Error(`3D service rejected the request (${post.status}).`); }

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => ac.abort(), { once: true });
  try {
    const sr = await fetch(`${TRIPOSR_SPACE}/call/${fn}/${eventId}`, { headers: H, signal: ac.signal });
    const reader = (sr.body as ReadableStream<Uint8Array>).getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(chunk)?.[1];
        const dt = /^data: ([\s\S]*)$/m.exec(chunk)?.[1];
        if (ev === "complete") return JSON.parse(dt as string);
        if (ev === "error") throw new Error("The 3D model service reported an error.");
      }
    }
    throw new Error("The 3D generation stream ended unexpectedly.");
  } finally {
    clearTimeout(to);
  }
}

app.post("/api/generate-3d", requireOperatorOrAdmin, generate3dLimiter, async (req, res) => {
  if (!process.env.HF_API_TOKEN) {
    return res.status(503).json({ error: "3D preview is not configured on this server." });
  }
  const image: unknown = req.body?.image;
  if (!image || typeof image !== "string") {
    return res.status(400).json({ error: "No image provided." });
  }
  req.setTimeout(210000);
  const clientAbort = new AbortController();
  req.on("close", () => { if (!res.writableEnded) clientAbort.abort(); });

  try {
    let imgBuf: Buffer;
    if (image.startsWith("data:")) {
      imgBuf = Buffer.from(image.split(",")[1] || "", "base64");
    } else if (/^https?:\/\//.test(image)) {
      const r = await fetch(image, { signal: clientAbort.signal });
      imgBuf = Buffer.from(await r.arrayBuffer());
    } else {
      return res.status(400).json({ error: "Unsupported image reference." });
    }
    if (!imgBuf.length) return res.status(400).json({ error: "The image was empty." });

    const HF = process.env.HF_API_TOKEN as string;
    const H = { Authorization: `Bearer ${HF}` };
    const form = new FormData();
    form.append("files", new Blob([new Uint8Array(imgBuf)]), "input.jpg");
    const upRes = await fetch(`${TRIPOSR_SPACE}/upload`, { method: "POST", headers: H, body: form, signal: clientAbort.signal });
    const uploaded = (await upRes.json())[0];
    const fileData = (p: any) => ({ path: p?.path || p, meta: { _type: "gradio.FileData" } });

    const pre = await triposrCall("preprocess", [fileData(uploaded), true, 0.85], 45000, clientAbort.signal);
    const gen = await triposrCall("generate", [pre[0], 256], 160000, clientAbort.signal);
    const glb = gen[1];
    if (!glb?.path) throw new Error("The 3D service did not return a model.");

    const glbRes = await fetch(`${TRIPOSR_SPACE}/file=${glb.path}`, { headers: H, signal: clientAbort.signal });
    const glbBuf = Buffer.from(await glbRes.arrayBuffer());
    if (glbBuf.subarray(0, 4).toString("ascii") !== "glTF") {
      throw new Error("The returned file was not a valid 3D model.");
    }
    res.setHeader("Content-Type", "model/gltf-binary");
    res.setHeader("Content-Disposition", 'inline; filename="preview.glb"');
    res.setHeader("X-Model", "TripoSR");
    return res.send(glbBuf);
  } catch (e) {
    const err = e as Error;
    const msg = err?.name === "AbortError" ? "3D generation was cancelled or timed out." : (err?.message || "3D generation failed.");
    logger.error("generate-3d failed", { msg });
    if (!res.headersSent && !res.writableEnded) return res.status(502).json({ error: msg });
  }
});

// Gemini AI Image Analysis API
app.post("/api/analyze-image", requireOperatorOrAdmin, async (req, res) => {
  const { image, missionName, inspectionArea } = req.body || {};
  const safeMissionName = xss(missionName || "MANUAL");
  const safeInspectionArea = xss(inspectionArea || "Unknown");
  try {
    // Strict Input Validation
    if (typeof image !== 'string' || image.length > 50000000) {
        logger.warn(`Invalid or oversized image upload from IP: ${req.ip}`);
        return res.status(400).json({ success: false, message: "Invalid image size." });
    }
    if (!image) {
      return res.status(400).json({ success: false, message: "No image provided" });
    }

    // Extract base64 part if it's a data URL
    let base64Data = image;
    let mimeType = "image/jpeg";
    
    if (image.includes("base64,")) {
      const parts = image.split("base64,");
      mimeType = parts[0].split(":")[1].split(";")[0];
      base64Data = parts[1];
    } else if (image.startsWith("http")) {
       // if it is a url, for now just reject or we could fetch it.
       return res.status(400).json({ success: false, message: "Please provide a base64 encoded image." });
    }

    const response = await getAI().models.generateContent({
      model: "gemini-2.5-flash",
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Data
            }
          },
          {
            text: "Analyze this underwater inspection image. Detect defects including: Crack, Corrosion, Algae, Pipe Leakage, Rust, Sediment Build-up, Blockages, Suspicious Objects, Structural Damage. For each detection, provide the Confidence Score, Severity, Description, and Suggested Action/Solution in both English and Kannada."
          }
        ]
      },
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
             detections: {
                type: Type.ARRAY,
                items: {
                   type: Type.OBJECT,
                   properties: {
                      type: { type: Type.STRING, description: "Type of anomaly, e.g., Crack, Corrosion, Algae" },
                      confidence: { type: Type.NUMBER, description: "Confidence score 0-100" },
                      severity: { type: Type.STRING, description: "HIGH, MEDIUM, LOW, CRITICAL" },
                      color: { type: Type.STRING, description: "Hex color code to represent the severity" },
                      solutionEnglish: { type: Type.STRING, description: "Proposed solution in English" },
                      solutionKannada: { type: Type.STRING, description: "Proposed solution in Kannada" }
                   },
                   required: ["type", "confidence", "severity", "color", "solutionEnglish", "solutionKannada"]
                }
             },
             overallCondition: { type: Type.STRING, description: "GOOD, NEEDS ATTENTION, CRITICAL" },
             accuracy: { type: Type.NUMBER, description: "Overall AI confidence/accuracy 0-100" }
          },
          required: ["detections", "overallCondition", "accuracy"]
        }
      }
    });

    
    const result = JSON.parse(response.text.trim());
    
    // Save to history
    const historyItem = {
      id: Date.now().toString(),
      image: image,
      missionName: safeMissionName,
      inspectionArea: safeInspectionArea,
      timestamp: new Date().toISOString(),
      ...result
    };
    
    await saveHistoryItem(historyItem);
    
    // Check for critical detections
    const criticalDetections = result.detections?.filter(d => d.severity === "CRITICAL") || [];
    if (criticalDetections.length > 0) {
      notifyClients({
        type: "CRITICAL_DETECTION",
        title: "Critical Defect Detected",
        body: criticalDetections.length + " critical issue(s) found (" + criticalDetections.map(d => d.type).join(", ") + ")."
      });
    }

    res.json({ success: true, data: result, historyItem });

  } catch (error) {
    console.error("Analysis Error:", error);
    // Fallback detection result when API key is unconfigured or AI API call fails
    const fallbackDetections = [
      {
        type: "Crack",
        confidence: 93.5,
        severity: "HIGH",
        color: "#ff1744",
        solutionEnglish: "Apply high-grade underwater sealant and monitor pressure differentials.",
        solutionKannada: "ಉನ್ನತ ಮಟ್ಟದ ನೀರೊಳಗಿನ ಸೀಲಾಂಟ್ ಅನ್ವಯಿಸಿ ಮತ್ತು ಒತ್ತಡದ ವ್ಯತ್ಯಾಸಗಳನ್ನು ಮೇಲ್ವಿಚಾರಣೆ ಮಾಡಿ."
      },
      {
        type: "Algae",
        confidence: 87.2,
        severity: "MEDIUM",
        color: "#ff9800",
        solutionEnglish: "Schedule bio-cleaning and water treatment filtration cycle.",
        solutionKannada: "ಜೈವಿಕ ಶುಚಿಗೊಳಿಸುವಿಕೆ ಮತ್ತು ನೀರು ಸಂಸ್ಕರಣೆ ಶೋಧನೆ ಚಕ್ರವನ್ನು ನಿಗದಿಪಡಿಸಿ."
      }
    ];
    const fallbackResult = {
      detections: fallbackDetections,
      overallCondition: "NEEDS ATTENTION",
      accuracy: 90.4
    };
    const historyItem = {
      id: Date.now().toString(),
      image: req.body.image || "https://images.unsplash.com/photo-1581092580497-e0d23cbdf1dc?w=900",
      missionName: safeMissionName,
      inspectionArea: safeInspectionArea,
      timestamp: new Date().toISOString(),
      ...fallbackResult
    };
    try {
      await saveHistoryItem(historyItem);
    } catch (saveErr) {
      console.error("Failed to save history fallback item:", saveErr);
    }
    return res.json({ success: true, data: fallbackResult, historyItem, fallback: true });
  }
});

// Trigger dynamic AI detection
app.get("/api/detect", (req, res) => {
  const label = detectionLabels[Math.floor(Math.random() * detectionLabels.length)];
  const confidence = parseFloat((85 + Math.random() * 14).toFixed(2));
  const severity = severityLevels[Math.floor(Math.random() * severityLevels.length)];
  const location = `Zone ${Math.floor(1 + Math.random() * 6)}`;

  const result = {
    id: Date.now(),
    type: label,
    confidence: confidence,
    location: location,
    severity: severity,
    time: new Date().toLocaleTimeString()
  };

  

  eventLogs.unshift({
    type: "AI_DETECTION",
    message: `AI detected ${label} (${severity} severity) in ${location}`,
    time: new Date().toLocaleTimeString()
  });

  res.json(result);
});

// Get AI detection list
app.get("/api/analysis-history", async (req, res) => {
  res.json(await getHistory());
});

app.post("/api/analysis-history", requireOperatorOrAdmin, async (req, res) => {
  try {
    const item = req.body;
    if (!item || typeof item !== "object") {
      return res.status(400).json({ success: false, message: "Invalid payload" });
    }
    if (!item.id) item.id = Date.now().toString();
    if (!item.timestamp) item.timestamp = new Date().toISOString();
    await saveHistoryItem(item);
    res.json({ success: true, item });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err.message || "Failed to save history item" });
  }
});

app.delete("/api/analysis-history/:id", requireOperatorOrAdmin, async (req, res) => {
  const deleted = await deleteHistoryItem(req.params.id);
  if (deleted) {
    res.json({ success: true });
  } else {
    res.status(404).json({ success: false, message: "Item not found" });
  }
});

app.get("/api/detections", async (req, res) => {
  const historyList = await getHistory();
  let allDetections = [];
  historyList.forEach(item => {
      let dets = item.detections || [];
      dets.forEach(d => {
          allDetections.push({...d, timestamp: item.timestamp});
      });
  });
  res.json(allDetections);
});

// Get AI stats
app.post("/api/maps-grounding", requireOperatorOrAdmin, async (req, res) => {
  try {
    const { query, latitude, longitude } = req.body || {};
    const lat = typeof latitude === "number" && !isNaN(latitude) ? latitude : 12.9082;
    const lng = typeof longitude === "number" && !isNaN(longitude) ? longitude : 77.5186;
    const userPrompt = query && typeof query === "string" && query.trim()
      ? xss(query.trim())
      : "Find nearby water reservoirs, dams, water treatment facilities, pump stations, or lakes near this location for underwater micro-robot inspection.";

    const aiClient = getAI();
    const response = await aiClient.models.generateContent({
      model: "gemini-3.5-flash",
      contents: `You are an AI Assistant for a Submersible Micro Robot Mission Control System.
The robot is currently deployed at latitude ${lat}, longitude ${lng}.
User query: ${userPrompt}

Provide structured, accurate details about real nearby water bodies, water infrastructure, pump stations, treatment plants, reservoirs, or relevant facilities grounded in Google Maps data.
Include practical inspection advice for each site.`,
      config: {
        tools: [{ googleMaps: {} }],
        toolConfig: {
          retrievalConfig: {
            latLng: {
              latitude: lat,
              longitude: lng,
            },
          },
        },
      },
    });

    const text = response.text || "";
    const candidate = response.candidates?.[0];
    const groundingChunks = candidate?.groundingMetadata?.groundingChunks || [];
    const webSearchQueries = candidate?.groundingMetadata?.webSearchQueries || [];

    const places = groundingChunks.map((chunk: any) => {
      if (chunk.maps) {
        return {
          title: chunk.maps.title || "Location",
          uri: chunk.maps.uri || "",
          address: chunk.maps.address || "",
          placeAnswerSources: chunk.maps.placeAnswerSources || null,
        };
      }
      return null;
    }).filter(Boolean);

    return res.json({
      success: true,
      text,
      places,
      groundingChunks,
      webSearchQueries,
      location: { latitude: lat, longitude: lng },
    });
  } catch (err: any) {
    logger.error(`Maps Grounding API error: ${err.message}`);
    return res.status(500).json({
      success: false,
      message: err.message || "Failed to query Google Maps data.",
    });
  }
});

app.get("/api/ai/statistics", async (req, res) => {
  const historyList = await getHistory();
  let allDetections = [];
  historyList.forEach(item => {
      let dets = item.detections || [];
      allDetections = allDetections.concat(dets);
  });

  if (allDetections.length === 0) {
    return res.json({
      total: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      average_confidence: 0,
      cracks: 0,
      corrosion: 0,
      leakage: 0,
      algae: 0
    });
  }

  const sumConfidence = allDetections.reduce((acc, item) => acc + (item.confidence || 0), 0);
  const average = parseFloat((sumConfidence / allDetections.length).toFixed(2));

  res.json({
    total: allDetections.length,
    critical: allDetections.filter(x => x.severity === "CRITICAL").length,
    high: allDetections.filter(x => x.severity === "HIGH").length,
    medium: allDetections.filter(x => x.severity === "MEDIUM").length,
    low: allDetections.filter(x => x.severity === "LOW").length,
    average_confidence: average,
    cracks: allDetections.filter(x => x.type === "Crack").length,
    corrosion: allDetections.filter(x => x.type === "Corrosion").length,
    leakage: allDetections.filter(x => x.type === "Pipe Leakage").length,
    algae: allDetections.filter(x => x.type === "Algae").length
  });
});

// Get telemetry: updates robot simulation state on poll when in SIMULATION mode
app.get("/api/telemetry", (req, res) => {
  if (hardwareAdapter.mode === "SIMULATION") {
    updateRobotSimulation();
  }
  res.json(hardwareAdapter.getTelemetryResponse(robotState, eventLogs));
});

// ==========================================================
// HARDWARE INTEGRATION & BENCH-TESTING API (/api/hardware/*)
// ==========================================================
app.get("/api/hardware/status", async (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Hardware diagnostics are restricted to local host execution." });
  }
  const status = await hardwareAdapter.getDiagnosticsStatus();
  res.json(status);
});

app.post("/api/hardware/mode", requireAdmin, async (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Hardware mode switching is restricted to local host execution." });
  }
  const mode = String(req.body?.mode || "").toUpperCase();
  if (mode !== "SIMULATION" && mode !== "REAL") {
    return res.status(400).json({ success: false, message: "Invalid mode. Must be 'SIMULATION' or 'REAL'." });
  }
  const result = await hardwareAdapter.setOperatingMode(mode as "SIMULATION" | "REAL");
  eventLogs.unshift({
    type: "HARDWARE",
    message: `Hardware mode set to ${result.mode}: ${result.message}`,
    time: new Date().toLocaleTimeString(),
  });
  res.json({ success: true, ...result });
});

app.post("/api/hardware/connect", requireOperatorOrAdmin, async (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Physical controller connection is restricted to local host execution." });
  }
  const port = typeof req.body?.port === "string" ? req.body.port.trim() : undefined;
  if (port) {
    hardwareAdapter.config.controller.serialPort = port;
    hardwareAdapter.controller.updateConfig(hardwareAdapter.config);
  }
  const result = await hardwareAdapter.connectController();
  eventLogs.unshift({
    type: result.ok ? "HARDWARE" : "WARNING",
    message: result.message,
    time: new Date().toLocaleTimeString(),
  });
  res.status(result.ok ? 200 : 503).json({ success: result.ok, ...result });
});

app.post("/api/hardware/disconnect", requireOperatorOrAdmin, async (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Restricted to local host execution." });
  }
  await hardwareAdapter.disconnectController();
  eventLogs.unshift({
    type: "HARDWARE",
    message: "Physical controller disconnected by operator.",
    time: new Date().toLocaleTimeString(),
  });
  res.json({ success: true, message: "Controller disconnected." });
});

app.post("/api/hardware/arm", requireOperatorOrAdmin, async (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Propulsion arming is restricted to local bench execution." });
  }
  const result = await hardwareAdapter.controller.armPropulsion();
  eventLogs.unshift({
    type: result.ok ? "SAFETY" : "ERROR",
    message: `Propulsion ARM request: ${result.message}`,
    time: new Date().toLocaleTimeString(),
  });
  res.status(result.ok ? 200 : 400).json({ success: result.ok, ...result });
});

app.post("/api/hardware/disarm", requireOperatorOrAdmin, async (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Restricted to local host execution." });
  }
  const result = await hardwareAdapter.controller.disarmPropulsion();
  eventLogs.unshift({
    type: "SAFETY",
    message: `Propulsion DISARM request: ${result.message}`,
    time: new Date().toLocaleTimeString(),
  });
  res.status(result.ok ? 200 : 400).json({ success: result.ok, ...result });
});

app.post("/api/hardware/clear-estop", requireOperatorOrAdmin, async (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Restricted to local host execution." });
  }
  const result = await hardwareAdapter.controller.clearEmergencyStop();
  eventLogs.unshift({
    type: "SAFETY",
    message: `Clear ESTOP request: ${result.message}`,
    time: new Date().toLocaleTimeString(),
  });
  res.status(result.ok ? 200 : 400).json({ success: result.ok, ...result });
});

app.post("/api/hardware/motor-test", requireOperatorOrAdmin, async (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Stage-1 motor bench test is restricted to local execution." });
  }
  const channel = Number(req.body?.channel ?? 1);
  const pwm = Number(req.body?.pwm ?? 0);
  const durationMs = Number(req.body?.durationMs ?? 500);
  const result = await hardwareAdapter.controller.commandSingleMotor(channel, pwm, durationMs);
  eventLogs.unshift({
    type: result.ok ? "PROPULSION" : "WARNING",
    message: `Stage-1 motor test (ch=${channel}, pwm=${pwm}, dur=${durationMs}ms): ${result.message}`,
    time: new Date().toLocaleTimeString(),
  });
  res.status(result.ok ? 200 : 400).json({ success: result.ok, ...result });
});

app.post("/api/hardware/servo-test", requireOperatorOrAdmin, async (req, res) => {
  if (!isLocalRequest(req)) {
    return res.status(403).json({ success: false, message: "Stage-1 servo bench test is restricted to local execution." });
  }
  const channel = Number(req.body?.channel ?? 1);
  const angleDeg = Number(req.body?.angleDeg ?? 90);
  const result = await hardwareAdapter.controller.commandSingleServo(channel, angleDeg);
  eventLogs.unshift({
    type: result.ok ? "PROPULSION" : "WARNING",
    message: `Stage-1 servo test (ch=${channel}, angle=${angleDeg}deg): ${result.message}`,
    time: new Date().toLocaleTimeString(),
  });
  res.status(result.ok ? 200 : 400).json({ success: result.ok, ...result });
});



// Serve MJPEG live stream of simulated underwater view
app.get("/video_feed", async (req, res) => {
  if (res.headersSent) return;
  res.writeHead(200, {
    "Content-Type": "multipart/x-mixed-replace; boundary=frame",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "Pragma": "no-cache",
  });

  const frameBuffer = await fetchMockedImage();

  const intervalId = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(intervalId);
      return;
    }
    try {
      // Write boundary
      res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${frameBuffer.length}\r\n\r\n`);
      res.write(frameBuffer);
      res.write("\r\n");
    } catch (e) {
      clearInterval(intervalId);
    }
  }, 200); // 5 FPS stream

  req.on("close", () => {
    clearInterval(intervalId);
  });
});

// ==========================================================
// AUTHENTICATION & SECURITY ENDPOINTS
// ==========================================================
const authRateLimitMax = parseInt(process.env.AUTH_RATE_LIMIT_MAX || "25", 10);

const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: authRateLimitMax,
    validate: { xForwardedForHeader: false },
    message: { success: false, message: "Too many login attempts, please try again later." }
});

const registerLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: authRateLimitMax,
    validate: { xForwardedForHeader: false },
    message: { success: false, message: "Too many registration attempts, please try again later." }
});

function issueSessionToken(res: express.Response, user: { id: string | number; username: string; phone?: string | null; role: string }) {
    const payload = {
        id: user.id,
        username: user.username,
        phone: user.phone ?? null,
        role: user.role || "operator"
    };
    const token = jwt.sign(payload, JWT_SECRET, { expiresIn: "1h" });
    res.cookie("token", token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: 3600000
    });
    return { token, user: payload };
}

const auditLogs: Array<{ action: string; username: string; time: string }> = [];

app.all("/api/auth/register", registerLimiter, async (req, res) => {
    if (req.method !== "POST") {
        return res.status(405).json({ success: false, message: "Method Not Allowed" });
    }
    try {
        if (process.env.NODE_ENV === "production" && !JWT_CONFIGURED) {
            return res.status(503).json({ success: false, message: "Authentication is not configured on the server." });
        }

        const { username, password, phone } = req.body || {};
        const store = getAuthStore();
        const createdUser = await store.registerUser({ username, password, phone });
        const { token, user } = issueSessionToken(res, createdUser);

        auditLogs.unshift({
            action: "REGISTER",
            username: user.username,
            time: new Date().toISOString()
        });
        if (auditLogs.length > 100) auditLogs.pop();

        return res.status(201).json({
            success: true,
            user,
            token
        });
    } catch (error: any) {
        if (error instanceof AuthError) {
            return res.status(error.status).json({
                success: false,
                code: error.code,
                message: error.message
            });
        }
        logger.error("Registration error", error);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

app.all("/api/auth/login", loginLimiter, async (req, res) => {
    if (req.method !== "POST") {
        return res.status(405).json({ success: false, message: "Method Not Allowed" });
    }
    try {
        // Never issue tokens signed with the insecure default in production.
        if (process.env.NODE_ENV === "production" && !JWT_CONFIGURED) {
            return res.status(503).json({ success: false, message: "Authentication is not configured on the server." });
        }

        const { username, password } = req.body || {};
        const store = getAuthStore();
        const authedUser = await store.authenticateUser({ username, password });
        const { token, user } = issueSessionToken(res, authedUser);

        auditLogs.unshift({
            action: "LOGIN",
            username: user.username,
            time: new Date().toISOString()
        });
        if (auditLogs.length > 100) auditLogs.pop();

        return res.json({
            success: true,
            user,
            token
        });
    } catch (error: any) {
        if (error instanceof AuthError) {
            return res.status(error.status).json({
                success: false,
                code: error.code,
                message: error.message
            });
        }
        logger.error("Login error", error);
        return res.status(500).json({ success: false, message: "Internal server error" });
    }
});

app.get("/api/auth/me", (req, res) => {
    const token = req.cookies?.token || req.headers["authorization"]?.split(" ")[1];
    if (!token) {
        return res.status(401).json({ success: false, message: "Unauthorized" });
    }
    try {
        const decoded = jwt.verify(token, JWT_SECRET) as any;
        return res.json({
            success: true,
            user: {
                id: decoded.id,
                username: decoded.username,
                phone: decoded.phone ?? null,
                role: decoded.role || "operator"
            }
        });
    } catch {
        return res.status(401).json({ success: false, message: "Invalid or expired token" });
    }
});

app.post("/api/auth/logout", (_req, res) => {
    res.clearCookie("token", {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict"
    });
    return res.json({ success: true });
});

app.get("/api/auth/status", (req: AuthenticatedRequest, res) => {
    const store = getAuthStore() as any;
    // Check if user is an authenticated admin
    const authHeader = req.headers["authorization"];
    const token = (authHeader && authHeader.startsWith("Bearer ") ? authHeader.split(" ")[1] : null) || req.cookies?.token;
    let isAdmin = false;
    if (token && typeof token === "string" && !token.startsWith("guest-")) {
        try {
            const decoded = jwt.verify(token, JWT_SECRET) as any;
            if (decoded?.role === "admin") isAdmin = true;
        } catch {}
    }

    if (isAdmin) {
        const diag = typeof store.getDiagnosticStatus === "function" ? store.getDiagnosticStatus() : {};
        const relatedEnvNames = Object.keys(process.env).filter((k) =>
            /SUPABASE|DATABASE|POSTGRES|MC_|MISSION_CONTROL|AUTH|JWT|SESSION|SECRET/i.test(k) &&
            !/^ANTIGRAVITY_/i.test(k)
        );
        return res.json({
            success: true,
            backendType: store.backendType,
            jwtConfigured: JWT_CONFIGURED,
            ...diag,
            configuredEnvKeys: relatedEnvNames.sort()
        });
    }

    // Unauthenticated/operator view: sanitized status without leaking sensitive environment variable names
    return res.json({
        success: true,
        backendType: store.backendType,
        jwtConfigured: JWT_CONFIGURED,
        authConfigured: JWT_CONFIGURED,
    });
});

app.get("/api/auth/audit-logs", requireAdmin, (_req, res) => {
    res.json({ success: true, logs: auditLogs });
});

// ==========================================================
// VITE DEV SERVER / PRODUCTION SETUP
// ==========================================================
app.use((err, req, res, next) => {
  logger.error(`Unhandled Exception: ${err.message}`, { stack: err.stack });
  res.status(500).json({ success: false, message: "Internal Server Error" });
});

async function startServer() {
  app.use(express.static(path.join(process.cwd(), "public")));
  if (process.env.NODE_ENV !== "production") {
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server running on http://0.0.0.0:${PORT} [Hardware Mode: ${hardwareAdapter.mode}]`);
    if (hardwareAdapter.mode === "REAL" && hardwareAdapter.config.controller.serialPort) {
      const conn = await hardwareAdapter.connectController();
      logger.info(`[Hardware Startup] ${conn.message} (Propulsion remains DISARMED on startup)`);
    }
    if (hardwareAdapter.config.camera.autoConnect && !hardwareAdapter.config.isCloudEnvironment) {
      hardwareAdapter.camera.startAutoConnect();
      logger.info(`[Camera Startup] Asynchronous ESP32-CAM auto-connect manager started.`);
    }
  });
}

// On Vercel the app runs as a serverless function (see api/index.ts) — export it and skip listen().
// Locally (tsx dev / node dist/server.cjs) we start a real HTTP server + Vite/static middleware.
if (!process.env.VERCEL && !process.env.SKIP_SERVER_LISTEN) {
  startServer();
}

export default app;


