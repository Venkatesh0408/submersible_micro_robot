import { useEffect, useState, useRef } from "react";
import { useMission } from "../context/MissionContext";
import {
  WifiOff, Wifi, Camera, Video, CheckCircle, AlertTriangle, AlertCircle, Clock,
  Loader2, X, Maximize2, Minimize2, ZoomIn, Eye, Crosshair, Download, Settings, Save, RefreshCw
} from "lucide-react";
import {
  fetchMedia, captureEspSnapshot, getCameraStatus,
  getRobotConfig, saveRobotConfig, testCameraConnection
} from "../services/api";
import "../styles/Camera.css";

const STANDARD_CAM_ENVIRONMENTS = ["Water Tank", "River", "Lake", "Pipeline", "Dam", "Wastewater Plant"];
const btnGhost = { display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 14px", borderRadius: "10px", border: "1px solid rgba(255,255,255,.15)", background: "transparent", color: "#c7d5e6", fontWeight: 600, fontSize: "13px", cursor: "pointer" };

export default function CameraPanel() {
  const { missionName, setMissionName, inspectionArea, setInspectionArea, missionStarted, missionPaused } = useMission();
  const [isCustomEnv, setIsCustomEnv] = useState(() => Boolean(inspectionArea && !STANDARD_CAM_ENVIRONMENTS.includes(inspectionArea)));

  useEffect(() => {
    if (inspectionArea && !STANDARD_CAM_ENVIRONMENTS.includes(inspectionArea)) {
      setIsCustomEnv(true);
    }
  }, [inspectionArea]);

  // Clean up legacy localStorage keys from prior manual IP configuration
  useEffect(() => {
    try {
      localStorage.removeItem("espIp");
      localStorage.removeItem("espPort");
      localStorage.removeItem("espPath");
      localStorage.removeItem("espUseProxy");
    } catch {}
  }, []);

  const [fps] = useState(30);
  const [resolution] = useState("VGA / SVGA");

  // Camera connection & configuration states
  const [cameraIp, setCameraIp] = useState("");
  const [streamPort, setStreamPort] = useState(81);
  const [capturePort, setCapturePort] = useState(80);
  const [streamPath, setStreamPath] = useState("/stream");
  const [capturePath, setCapturePath] = useState("/capture");
  const [connectionMode, setConnectionMode] = useState("LOCAL_GATEWAY");
  const [showConfigDrawer, setShowConfigDrawer] = useState(false);
  const [isSavingConfig, setIsSavingConfig] = useState(false);
  const [isTestingConnection, setIsTestingConnection] = useState(false);
  const [connectionState, setConnectionState] = useState("Disconnected"); // "Connected" | "Connecting" | "Disconnected" | "Invalid IP" | "Connection timeout"
  const [connectionMessage, setConnectionMessage] = useState("");
  const [streamKey, setStreamKey] = useState(0);

  // Viewport states
  const [espConnected, setEspConnected] = useState(false);
  const [espLatency, setEspLatency] = useState(null);
  const [capturingSnapshot, setCapturingSnapshot] = useState(false);
  const [statusNotice, setStatusNotice] = useState("");
  const [espNoticeDismissed, setEspNoticeDismissed] = useState(false);

  // Interactive Viewport HUD States
  const [zoomLevel, setZoomLevel] = useState(1); // 1x, 1.5x, 2x
  const [showReticle, setShowReticle] = useState(true);
  const [marineFilter, setMarineFilter] = useState(false);
  const [flashActive, setFlashActive] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [recentSnapshots, setRecentSnapshots] = useState([]);
  const [lightboxImg, setLightboxImg] = useState(null);
  const [radarTarget, setRadarTarget] = useState(null);

  const canvasRef = useRef(null);
  const viewportRef = useRef(null);

  // Same-origin stream endpoint proxied by backend
  const streamUrl = "/api/camera/stream";

  // 1. Load user's saved robot & camera configuration from database on mount
  useEffect(() => {
    let isMounted = true;
    const loadSavedConfig = async () => {
      try {
        const res = await getRobotConfig();
        if (isMounted && res?.success && res?.config) {
          const cfg = res.config;
          if (cfg.cameraIp) setCameraIp(cfg.cameraIp);
          if (cfg.streamPort) setStreamPort(cfg.streamPort);
          if (cfg.capturePort) setCapturePort(cfg.capturePort);
          if (cfg.streamPath) setStreamPath(cfg.streamPath);
          if (cfg.capturePath) setCapturePath(cfg.capturePath);
          if (cfg.connectionMode) setConnectionMode(cfg.connectionMode);

          if (cfg.isVerified && cfg.cameraIp) {
            setConnectionState("Connected");
            setEspConnected(true);
          }
        }
      } catch (err) {
        console.warn("Failed to load saved robot config:", err);
      }
    };

    loadSavedConfig();
    return () => { isMounted = false; };
  }, []);

  // 2. Background camera status sync with backend
  useEffect(() => {
    let isMounted = true;
    const syncStatus = async () => {
      try {
        const res = await getCameraStatus(true);
        if (isMounted && res?.status) {
          const isOnline = Boolean(res.status.online);
          setEspConnected(isOnline);
          setEspLatency(res.status.latencyMs ?? null);
          if (isOnline) {
            setConnectionState("Connected");
            setConnectionMessage(res.status.message || "ESP32-CAM stream is reachable.");
          }
        }
      } catch (err) {
        if (isMounted) {
          setEspConnected(false);
          setEspLatency(null);
        }
      }
    };

    syncStatus();
    const timer = setInterval(syncStatus, 5000);
    return () => {
      isMounted = false;
      clearInterval(timer);
    };
  }, []);

  // Re-show offline notice whenever connection state flips
  useEffect(() => { setEspNoticeDismissed(false); }, [espConnected]);

  // Load saved snapshots & media from backend
  const loadRecentMedia = async () => {
    try {
      const files = await fetchMedia();
      if (Array.isArray(files)) {
        const snaps = files.filter(f => f.type === "image" || f.filename?.endsWith('.jpg') || f.filename?.endsWith('.png') || f.url?.endsWith('.jpg'));
        setRecentSnapshots(snaps.slice(0, 5));
      }
    } catch (err) {
      console.warn("Failed to fetch media:", err);
    }
  };

  useEffect(() => {
    loadRecentMedia();
  }, []);

  // Automatically sanitize camera input: extracts clean IP, port, and path if user pasted a full URL
  const handleIpChange = (val) => {
    let raw = val.trim();
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      try {
        const u = new URL(raw);
        setCameraIp(u.hostname);
        if (u.port) {
          const p = Number(u.port);
          if (p >= 1 && p <= 65535) {
            setStreamPort(p);
            setCapturePort(p);
            if (p === 8080) {
              setStreamPath("/video");
              setCapturePath("/shot.jpg");
            }
          }
        }
        if (u.pathname && u.pathname !== "/") {
          setStreamPath(u.pathname);
        }
        return;
      } catch {
        raw = raw.replace(/^https?:\/\//i, "");
      }
    }
    if (raw.includes(":")) {
      const parts = raw.split(":");
      const hostPart = parts[0].trim();
      const portPart = parts[1].split("/")[0].trim();
      const p = Number(portPart);
      if (p >= 1 && p <= 65535) {
        setStreamPort(p);
        setCapturePort(p);
        if (p === 8080) {
          setStreamPath("/video");
          setCapturePath("/shot.jpg");
        }
      }
      setCameraIp(hostPart);
      return;
    }
    setCameraIp(val);
  };

  // Save camera configuration permanently in database for authenticated user
  const handleSaveConfig = async () => {
    setIsSavingConfig(true);
    setStatusNotice("Saving camera configuration to database...");
    try {
      const res = await saveRobotConfig({
        cameraIp,
        streamPort: Number(streamPort) || 81,
        capturePort: Number(capturePort) || 80,
        streamPath: streamPath || "/stream",
        capturePath: capturePath || "/capture",
        connectionMode,
      });

      if (res?.success) {
        setStatusNotice("Camera configuration saved permanently!");
        setConnectionMessage(cameraIp ? `Target saved: ${cameraIp}:${streamPort}` : "Saved (No IP configured)");
        setTimeout(() => setStatusNotice(""), 4000);
      } else {
        setStatusNotice(res?.message || "Failed to save configuration.");
        if (res?.status) setConnectionState(res.status);
      }
    } catch (err) {
      setStatusNotice("Save error: " + (err?.message || "network failure"));
    } finally {
      setIsSavingConfig(false);
    }
  };

  // Test live connection to ESP32-CAM: validates response, checks latency, and verifies JPEG frames
  const handleTestConnection = async () => {
    setIsTestingConnection(true);
    setConnectionState("Connecting");
    setConnectionMessage("Probing ESP32-CAM stream and validating JPEG frames...");

    try {
      const res = await testCameraConnection({
        cameraIp,
        streamPort: Number(streamPort) || 81,
        capturePort: Number(capturePort) || 80,
        streamPath: streamPath || "/stream",
        capturePath: capturePath || "/capture",
      });

      if (res?.success && res?.status === "Connected") {
        setConnectionState("Connected");
        setEspConnected(true);
        setEspLatency(res.latencyMs ?? null);
        setConnectionMessage(res.message || "ESP32-CAM verified successfully. Valid JPEG stream received.");
        setStatusNotice("Connection verified! Live feed active.");
        setStreamKey(k => k + 1);
        setTimeout(() => setStatusNotice(""), 4000);
      } else {
        const state = res?.status || "Disconnected";
        setConnectionState(state);
        setEspConnected(false);
        setEspLatency(null);
        setConnectionMessage(res?.message || "Unable to reach camera at specified address.");
      }
    } catch (err) {
      setConnectionState("Disconnected");
      setEspConnected(false);
      setConnectionMessage("Test failed: " + (err?.message || "Network error"));
    } finally {
      setIsTestingConnection(false);
    }
  };

  // Interactive Live Snapshot Capture with Shutter Flash
  const handleCaptureSnapshot = async () => {
    setCapturingSnapshot(true);
    setFlashActive(true);
    setTimeout(() => setFlashActive(false), 450);
    setStatusNotice("Capturing live frame snapshot from ESP32-CAM...");

    try {
      const filename = `esp-snapshot-${Date.now()}.jpg`;
      const result = await captureEspSnapshot(filename);
      if (result?.success) {
        setStatusNotice(`Snapshot captured and saved as ${result.file?.filename || filename}!`);
        loadRecentMedia();
        setTimeout(() => setStatusNotice(""), 4000);
      } else {
        setStatusNotice(result?.message || "Failed to save ESP32 snapshot.");
        setTimeout(() => setStatusNotice(""), 4000);
      }
    } catch (err) {
      console.error("Snapshot Capture Error:", err);
      setStatusNotice("Snapshot capture error: " + (err?.message || "network error"));
      setTimeout(() => setStatusNotice(""), 3000);
    } finally {
      setCapturingSnapshot(false);
    }
  };

  // Cycle digital zoom
  const cycleZoom = () => {
    setZoomLevel((prev) => (prev === 1 ? 1.5 : prev === 1.5 ? 2 : 1));
  };

  // Fullscreen toggle
  const toggleFullscreen = () => {
    if (!viewportRef.current) return;
    if (!document.fullscreenElement) {
      viewportRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  };

  // Interactive Canvas Radar Fallback with Target Tracking
  useEffect(() => {
    if (espConnected) return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let animationFrameId;
    let angle = 0;

    const render = () => {
      ctx.fillStyle = "#030b12";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      // Coordinate Grid Lines
      ctx.strokeStyle = "rgba(18,211,224, 0.12)";
      ctx.lineWidth = 1;
      for (let x = 0; x < canvas.width; x += 40) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, canvas.height);
        ctx.stroke();
      }
      for (let y = 0; y < canvas.height; y += 40) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(canvas.width, y);
        ctx.stroke();
      }

      // Concentric Range Rings (25m, 50m, 75m, 100m scale)
      const rings = [60, 120, 180, 240];
      rings.forEach((r, idx) => {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(18,211,224, 0.22)";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = "rgba(18,211,224, 0.5)";
        ctx.font = "10px monospace";
        ctx.fillText(`${(idx + 1) * 25}m`, cx + r + 4, cy - 4);
      });

      // Rotating Sonar Sweep Beam
      angle += 0.025;
      ctx.save();
      ctx.translate(cx, cy);

      const gradient = ctx.createRadialGradient(0, 0, 10, 0, 0, 260);
      gradient.addColorStop(0, "rgba(34, 211, 238, 0.35)");
      gradient.addColorStop(1, "rgba(34, 211, 238, 0)");

      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.arc(0, 0, 250, angle - 0.25, angle);
      ctx.closePath();
      ctx.fillStyle = gradient;
      ctx.fill();

      // Sharp sweep leading line
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle) * 250, Math.sin(angle) * 250);
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Central Robot Indicator
      ctx.beginPath();
      ctx.arc(0, 0, 7, 0, Math.PI * 2);
      ctx.fillStyle = "#22d3ee";
      ctx.shadowColor = "#22d3ee";
      ctx.shadowBlur = 15;
      ctx.fill();

      // Brand Title
      ctx.font = "900 28px 'Orbitron', monospace";
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.fillText("PROJECT AQUA", 0, 130);

      ctx.restore();

      // Interactive Cursor Target Tracking
      if (radarTarget) {
        ctx.save();
        ctx.strokeStyle = "#ffb703";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(radarTarget.x, radarTarget.y, 16, 0, Math.PI * 2);
        ctx.stroke();

        ctx.fillStyle = "#ffb703";
        ctx.font = "bold 11px monospace";
        ctx.fillText(`TARGET: R=${radarTarget.range}m | BRG=${radarTarget.bearing}°`, radarTarget.x + 22, radarTarget.y + 4);
        ctx.restore();
      }

      // Simulation Badge
      ctx.fillStyle = "#22d3ee";
      ctx.font = "bold 12px monospace";
      ctx.fillText("● [SIMULATION] RADAR STANDBY - CAMERA OFFLINE", 20, 30);

      animationFrameId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationFrameId);
  }, [espConnected, radarTarget]);

  // Handle mouse interaction on radar canvas
  const handleCanvasMouseMove = (e) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;

    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const dx = x - cx;
    const dy = y - cy;
    const distPx = Math.sqrt(dx * dx + dy * dy);
    const rangeM = (distPx / 2.5).toFixed(1);
    let bearingDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI + 90);
    if (bearingDeg < 0) bearingDeg += 360;

    setRadarTarget({ x, y, range: rangeM, bearing: bearingDeg });
  };

  // Helper badge color & icon for the 5 connection states
  const getStatusBadge = () => {
    switch (connectionState) {
      case "Connected":
        return {
          bg: "#15803d",
          color: "#ffffff",
          icon: <CheckCircle size={14} className="text-white" />,
          label: "Connected",
        };
      case "Connecting":
        return {
          bg: "#b45309",
          color: "#ffffff",
          icon: <Loader2 size={14} className="animate-spin text-white" />,
          label: "Connecting...",
        };
      case "Connection timeout":
        return {
          bg: "#c2410c",
          color: "#ffffff",
          icon: <Clock size={14} className="text-white" />,
          label: "Connection timeout",
        };
      case "Invalid IP":
        return {
          bg: "#b91c1c",
          color: "#ffffff",
          icon: <AlertCircle size={14} className="text-white" />,
          label: "Invalid IP",
        };
      default:
        return {
          bg: "#334155",
          color: "#cbd5e1",
          icon: <WifiOff size={14} className="text-slate-300" />,
          label: "Disconnected",
        };
    }
  };

  const statusBadge = getStatusBadge();

  return (
    <div className="map-card camera-card" style={{
      background: "#0e1524",
      borderRadius: "20px",
      padding: "20px",
      boxShadow: "0 0 25px rgba(18,211,224, .2)",
      border: "1px solid rgba(18,211,224, .3)",
      display: "flex",
      flexDirection: "column",
      gap: "14px"
    }}>

      {/* Header matching MapPanel */}
      <div className="map-header" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '10px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
          <h2 style={{ color: '#ffffff', fontSize: '22px', margin: 0, fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Video size={22} className="text-cyan-500 animate-pulse" />
            📹 Mission Camera Control
          </h2>
          <span className="map-status" style={{
            background: espConnected ? '#15803d' : '#22d3ee',
            color: '#ffffff',
            padding: '6px 14px',
            borderRadius: '25px',
            fontWeight: 'bold',
            fontSize: '12px',
            boxShadow: espConnected ? '0 0 15px rgba(34,197,94,.4)' : '0 0 15px rgba(18,211,224,.4)'
          }}>
            {espConnected ? "LIVE ESP32-CAM" : "STANDBY RADAR"}
          </span>
        </div>

        {/* Inputs row */}
        <div style={{ display: 'flex', gap: '12px', width: '100%', paddingBottom: '4px', flexWrap: 'wrap' }}>
          <input 
            type="text" 
            placeholder="Mission Name (e.g. Mission 1)" 
            value={missionName || ""} 
            onChange={(e) => setMissionName && setMissionName(e.target.value)}
            disabled={missionStarted}
            style={{ flex: 1, minWidth: '160px', padding: '10px', borderRadius: '8px', border: '1px solid #22d3ee', background: '#16203a', color: 'white', outline: 'none' }}
          />
          <select 
            value={isCustomEnv ? "Custom" : (inspectionArea || "")} 
            onChange={(e) => {
              if (e.target.value === "Custom") {
                setIsCustomEnv(true);
                if (STANDARD_CAM_ENVIRONMENTS.includes(inspectionArea)) {
                  setInspectionArea && setInspectionArea("Custom Location");
                }
              } else {
                setIsCustomEnv(false);
                setInspectionArea && setInspectionArea(e.target.value);
              }
            }}
            disabled={missionStarted}
            style={{ flex: 1, minWidth: '140px', padding: '10px', borderRadius: '8px', border: '1px solid #22d3ee', background: '#16203a', color: 'white', outline: 'none' }}
          >
            <option value="">Select Inspection Area</option>
            <option value="Water Tank">Water Tank</option>
            <option value="River">River</option>
            <option value="Lake">Lake</option>
            <option value="Pipeline">Pipeline</option>
            <option value="Dam">Dam</option>
            <option value="Wastewater Plant">Wastewater Plant</option>
            <option value="Custom">Custom Location...</option>
          </select>

          {isCustomEnv && (
            <input 
              type="text" 
              placeholder="Enter Custom Location Name" 
              value={inspectionArea || ""} 
              onChange={(e) => setInspectionArea && setInspectionArea(e.target.value)}
              disabled={missionStarted}
              style={{ flex: 1, minWidth: '160px', padding: '10px', borderRadius: '8px', border: '1px solid #22d3ee', background: '#16203a', color: 'white', outline: 'none' }}
            />
          )}
        </div>
      </div>

      {/* ========================================================== */}
      {/* DYNAMIC ESP32-CAM HARDWARE CONFIGURATION & CONNECTION PANEL */}
      {/* ========================================================== */}
      <div style={{
        background: "rgba(11, 20, 36, 0.9)",
        border: "1px solid rgba(34, 211, 238, 0.3)",
        borderRadius: "14px",
        padding: "14px 16px",
        display: "flex",
        flexDirection: "column",
        gap: "10px",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.05)"
      }}>
        {/* Main IP Config Bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          gap: "10px",
          flexWrap: "wrap",
          justifyContent: "space-between"
        }}>
          {/* IP Input with icon */}
          <div style={{ display: "flex", alignItems: "center", gap: "8px", flex: 2, minWidth: "240px" }}>
            <span style={{ fontSize: "12px", color: "#93a1bc", fontWeight: 700, whiteSpace: "nowrap" }}>
              CAM IP:
            </span>
            <input
              type="text"
              placeholder="e.g. 192.168.1.184, 10.41.235.60"
              value={cameraIp}
              onChange={(e) => handleIpChange(e.target.value)}
              onBlur={(e) => handleIpChange(e.target.value)}
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: "8px",
                border: "1px solid rgba(34, 211, 238, 0.4)",
                background: "#16203a",
                color: "#22d3ee",
                fontFamily: "monospace",
                fontSize: "13px",
                fontWeight: 600,
                outline: "none"
              }}
            />
          </div>

          {/* Connection Status Badge (5 states) */}
          <div style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "6px",
            padding: "6px 12px",
            borderRadius: "999px",
            background: statusBadge.bg,
            color: statusBadge.color,
            fontSize: "11.5px",
            fontWeight: 700,
            boxShadow: "0 2px 8px rgba(0,0,0,0.3)"
          }}>
            {statusBadge.icon}
            <span>{statusBadge.label}</span>
          </div>

          {/* Action Buttons: Test, Save, Advanced */}
          <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={handleTestConnection}
              disabled={isTestingConnection}
              title="Verify camera stream, check reachability, and validate JPEG frames"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                borderRadius: "8px",
                border: "1px solid #22d3ee",
                background: "linear-gradient(135deg, rgba(34,211,238,0.25), rgba(14,116,144,0.4))",
                color: "#22d3ee",
                fontWeight: 700,
                fontSize: "12px",
                cursor: isTestingConnection ? "not-allowed" : "pointer",
                transition: "all 0.2s ease"
              }}
            >
              {isTestingConnection ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              Test Connection
            </button>

            <button
              onClick={handleSaveConfig}
              disabled={isSavingConfig}
              title="Save camera configuration permanently in database for this operator"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "6px",
                padding: "8px 14px",
                borderRadius: "8px",
                border: "1px solid rgba(34,197,94,0.6)",
                background: "linear-gradient(135deg, rgba(34,197,94,0.2), rgba(21,128,61,0.4))",
                color: "#4ade80",
                fontWeight: 700,
                fontSize: "12px",
                cursor: isSavingConfig ? "not-allowed" : "pointer",
                transition: "all 0.2s ease"
              }}
            >
              {isSavingConfig ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save Config
            </button>

            <button
              onClick={() => setShowConfigDrawer(!showConfigDrawer)}
              title="Configure ports, paths, and connection mode"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "5px",
                padding: "8px 10px",
                borderRadius: "8px",
                border: "1px solid rgba(255,255,255,0.15)",
                background: showConfigDrawer ? "rgba(34,211,238,0.2)" : "rgba(22,32,58,0.6)",
                color: showConfigDrawer ? "#22d3ee" : "#93a1bc",
                fontWeight: 600,
                fontSize: "12px",
                cursor: "pointer"
              }}
            >
              <Settings size={14} />
            </button>
          </div>
        </div>

        {/* Diagnostic Message / Error Banner */}
        {connectionMessage && (
          <div style={{
            fontSize: "11.5px",
            color: connectionState === "Connected" ? "#4ade80" : "#fca5a5",
            background: connectionState === "Connected" ? "rgba(34,197,94,0.1)" : "rgba(239,68,68,0.1)",
            border: `1px solid ${connectionState === "Connected" ? "rgba(34,197,94,0.3)" : "rgba(239,68,68,0.3)"}`,
            borderRadius: "6px",
            padding: "6px 10px",
            display: "flex",
            alignItems: "center",
            gap: "8px"
          }}>
            {connectionState === "Connected" ? <CheckCircle size={13} /> : <AlertTriangle size={13} />}
            <span>{connectionMessage}</span>
          </div>
        )}

        {/* Expandable Advanced Settings (Ports, Paths & Mode) */}
        {showConfigDrawer && (
          <div style={{
            borderTop: "1px solid rgba(34, 211, 238, 0.15)",
            paddingTop: "10px",
            display: "flex",
            flexDirection: "column",
            gap: "8px"
          }}>
            <div style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))",
              gap: "8px"
            }}>
              <div>
                <label style={{ fontSize: "10.5px", color: "#93a1bc", fontWeight: 600, display: "block", marginBottom: "3px" }}>
                  STREAM PORT:
                </label>
                <input
                  type="number"
                  value={streamPort}
                  onChange={(e) => setStreamPort(Number(e.target.value) || 81)}
                  style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #1e293b", background: "#16203a", color: "white", fontSize: "12px", outline: "none" }}
                />
              </div>

              <div>
                <label style={{ fontSize: "10.5px", color: "#93a1bc", fontWeight: 600, display: "block", marginBottom: "3px" }}>
                  STREAM PATH:
                </label>
                <input
                  type="text"
                  value={streamPath}
                  onChange={(e) => setStreamPath(e.target.value)}
                  style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #1e293b", background: "#16203a", color: "white", fontSize: "12px", outline: "none" }}
                />
              </div>

              <div>
                <label style={{ fontSize: "10.5px", color: "#93a1bc", fontWeight: 600, display: "block", marginBottom: "3px" }}>
                  CAPTURE PORT:
                </label>
                <input
                  type="number"
                  value={capturePort}
                  onChange={(e) => setCapturePort(Number(e.target.value) || 80)}
                  style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #1e293b", background: "#16203a", color: "white", fontSize: "12px", outline: "none" }}
                />
              </div>

              <div>
                <label style={{ fontSize: "10.5px", color: "#93a1bc", fontWeight: 600, display: "block", marginBottom: "3px" }}>
                  CAPTURE PATH:
                </label>
                <input
                  type="text"
                  value={capturePath}
                  onChange={(e) => setCapturePath(e.target.value)}
                  style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #1e293b", background: "#16203a", color: "white", fontSize: "12px", outline: "none" }}
                />
              </div>

              <div>
                <label style={{ fontSize: "10.5px", color: "#93a1bc", fontWeight: 600, display: "block", marginBottom: "3px" }}>
                  CONNECTION MODE:
                </label>
                <select
                  value={connectionMode}
                  onChange={(e) => setConnectionMode(e.target.value)}
                  style={{ width: "100%", padding: "6px 8px", borderRadius: "6px", border: "1px solid #1e293b", background: "#16203a", color: "#22d3ee", fontSize: "12px", outline: "none" }}
                >
                  <option value="LOCAL_GATEWAY">Local Gateway (Bench/LAN)</option>
                  <option value="CLOUD_REMOTE">Cloud Remote (Render)</option>
                </select>
              </div>
            </div>

            {/* Quick Camera Hardware Profile Presets */}
            <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap", padding: "4px 0" }}>
              <span style={{ fontSize: "11px", color: "#64748b", fontWeight: 600 }}>Presets:</span>
              <button
                type="button"
                onClick={() => {
                  setStreamPort(81);
                  setCapturePort(80);
                  setStreamPath("/stream");
                  setCapturePath("/capture");
                }}
                style={{
                  padding: "4px 10px",
                  fontSize: "11px",
                  borderRadius: "6px",
                  border: "1px solid rgba(14, 165, 233, 0.4)",
                  background: "rgba(14, 165, 233, 0.12)",
                  color: "#38bdf8",
                  cursor: "pointer",
                  fontWeight: 600
                }}
              >
                ESP32-CAM (81/80, /stream)
              </button>
              <button
                type="button"
                onClick={() => {
                  setStreamPort(8080);
                  setCapturePort(8080);
                  setStreamPath("/video");
                  setCapturePath("/shot.jpg");
                }}
                style={{
                  padding: "4px 10px",
                  fontSize: "11px",
                  borderRadius: "6px",
                  border: "1px solid rgba(16, 185, 129, 0.4)",
                  background: "rgba(16, 185, 129, 0.12)",
                  color: "#34d399",
                  cursor: "pointer",
                  fontWeight: 600
                }}
              >
                Phone IP Webcam (8080, /video)
              </button>
            </div>

            {/* Generated URLs Dynamic Preview */}
            <div style={{
              fontSize: "11px",
              fontFamily: "monospace",
              color: "#94a3b8",
              background: "#070d18",
              padding: "6px 10px",
              borderRadius: "6px",
              display: "flex",
              flexWrap: "wrap",
              gap: "12px"
            }}>
              <span>Live Stream: <b style={{ color: "#38bdf8" }}>{cameraIp ? `http://${cameraIp}:${streamPort}${streamPath}` : "Not configured"}</b></span>
              <span>Snapshot: <b style={{ color: "#38bdf8" }}>{cameraIp ? `http://${cameraIp}:${capturePort}${capturePath}` : "Not configured"}</b></span>
              <span>Proxy Endpoint: <b style={{ color: "#34d399" }}>/api/camera/stream</b></span>
            </div>
          </div>
        )}
      </div>

      {/* Main Interactive Video Viewport */}
      <div
        ref={viewportRef}
        style={{
          position: "relative",
          width: "100%",
          height: "440px",
          background: "#000000",
          borderRadius: "16px",
          overflow: "hidden",
          border: "2px solid rgba(18,211,224, 0.4)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          boxShadow: "inset 0 0 30px rgba(0,0,0,0.8)"
        }}
      >
        {/* Shutter flash animation on capture */}
        {flashActive && <div className="camera-flash-overlay" />}

        {/* Video / Canvas Layer with smooth digital zoom scaling */}
        <div
          style={{
            width: "100%",
            height: "100%",
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transform: `scale(${zoomLevel})`,
            transition: "transform 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
            transformOrigin: "center center"
          }}
          className={marineFilter ? "marine-vision-filter" : ""}
        >
          {espConnected ? (
            <img
              key={streamKey}
              src={`${streamUrl}?k=${streamKey}`}
              alt="ESP32-CAM Live Camera Stream"
              onError={() => {
                setEspConnected(false);
                setEspLatency(null);
                setConnectionState("Disconnected");
              }}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                filter: missionPaused ? "grayscale(100%) blur(2px)" : "none"
              }}
            />
          ) : (
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              onMouseMove={handleCanvasMouseMove}
              onMouseLeave={() => setRadarTarget(null)}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                filter: missionPaused ? "grayscale(100%) blur(2px)" : "none",
                cursor: "crosshair"
              }}
            />
          )}
        </div>

        {/* Tactical Reticle & Corner Brackets Overlay */}
        {showReticle && (
          <div className="hud-reticle-overlay">
            <div className="hud-corner hud-corner-tl" />
            <div className="hud-corner hud-corner-tr" />
            <div className="hud-corner hud-corner-bl" />
            <div className="hud-corner hud-corner-br" />
            <div className="hud-crosshair-center">
              <div className="hud-reticle-circle" />
            </div>
          </div>
        )}

        {/* Live HUD Status Badge (Top-Left) */}
        <div style={{
          position: "absolute",
          top: "12px",
          left: "12px",
          background: "rgba(14, 21, 36, 0.88)",
          border: "1px solid rgba(18,211,224, 0.5)",
          borderRadius: "8px",
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          backdropFilter: "blur(6px)",
          zIndex: 20
        }}>
          <span style={{
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: missionPaused ? "#eab308" : espConnected ? "#22c55e" : "#22d3ee",
            boxShadow: espConnected ? "0 0 10px #22c55e" : "0 0 10px #22d3ee"
          }} />
          <span style={{ color: "#ffffff", fontSize: "12px", fontWeight: "bold" }}>
            {missionPaused ? "MISSION PAUSED" : espConnected ? "LIVE ESP32-CAM" : "RADAR SIMULATION ACTIVE"}
          </span>
        </div>

        {/* Interactive Telemetry Ribbon (Bottom-Left) */}
        <div className="viewport-telemetry-ribbon">
          <span>FPS: <b>{fps}</b></span>
          <span>LATENCY: <b>{espLatency !== null ? `${espLatency}ms` : "LOW"}</b></span>
          <span>ZOOM: <b>{zoomLevel}x</b></span>
          <span>RES: <b>{resolution}</b></span>
        </div>

        {/* Interactive Action Toolbar (Bottom-Right HUD) */}
        <div className="viewport-control-bar">
          <button
            className={`hud-control-btn ${zoomLevel > 1 ? "active" : ""}`}
            onClick={cycleZoom}
            title="Cycle Digital Zoom (1x, 1.5x, 2x)"
          >
            <ZoomIn size={13} /> {zoomLevel}x
          </button>
          <button
            className={`hud-control-btn ${showReticle ? "active" : ""}`}
            onClick={() => setShowReticle(!showReticle)}
            title="Toggle Tactical Reticle Overlay"
          >
            <Crosshair size={13} /> Reticle
          </button>
          <button
            className={`hud-control-btn ${marineFilter ? "active" : ""}`}
            onClick={() => setMarineFilter(!marineFilter)}
            title="Toggle Marine Night Vision Filter"
          >
            <Eye size={13} /> Marine Vision
          </button>
          <button
            className="hud-control-btn"
            onClick={handleCaptureSnapshot}
            disabled={capturingSnapshot}
            title="Capture Instant Still Frame"
            style={{ color: "#22d3ee", borderColor: "#22d3ee" }}
          >
            {capturingSnapshot ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />} Snap
          </button>
          <button
            className="hud-control-btn"
            onClick={toggleFullscreen}
            title="Toggle Fullscreen Mode"
          >
            {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>

        {/* Dismissible Offline Banner */}
        {!espConnected && !espNoticeDismissed && (
          <div style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            maxWidth: "calc(100% - 24px)",
            background: "rgba(13,26,40, 0.94)",
            border: "1px solid #22d3ee",
            borderRadius: "8px",
            padding: "8px 12px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            backdropFilter: "blur(8px)",
            boxShadow: "0 0 15px rgba(18,211,224, 0.4)",
            zIndex: 25
          }}>
            <WifiOff size={16} style={{ color: "#22d3ee", flexShrink: 0 }} className="animate-pulse" />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "#ffffff", fontSize: "12px", fontWeight: "bold" }}>
                CAMERA OFFLINE — RETRYING CONNECTION
              </div>
              <div style={{ color: "#8296a8", fontSize: "10px", marginTop: "1px" }}>
                Enter camera IP above and click Test Connection | Live feed connects when hardware responds
              </div>
            </div>
            <button
              onClick={() => setEspNoticeDismissed(true)}
              aria-label="Dismiss"
              title="Dismiss"
              style={{ background: "transparent", color: "#8296a8", padding: 2, flexShrink: 0, display: "grid", placeItems: "center", cursor: "pointer", border: "none" }}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {/* Status Notice Toast / Banner */}
      {statusNotice && (
        <div style={{
          fontSize: "12px",
          color: "#22d3ee",
          background: "rgba(34,211,238,0.12)",
          border: "1px solid rgba(34,211,238,0.3)",
          borderRadius: "8px",
          padding: "8px 12px",
          display: "flex",
          alignItems: "center",
          gap: "8px"
        }}>
          <CheckCircle size={14} /> {statusNotice}
        </div>
      )}

      {/* Recent Captures Interactive Strip */}
      {recentSnapshots.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "12px", color: "#93a1bc", fontWeight: 600 }}>
            <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
              <Camera size={13} style={{ color: "#22d3ee" }} /> Recent Mission Captures
            </span>
            <span style={{ fontSize: "11px", color: "#5f7793" }}>Click to expand in lightbox</span>
          </div>
          <div className="snapshot-strip">
            {recentSnapshots.map((item, idx) => (
              <div
                key={item.id || idx}
                className="snapshot-thumb-card"
                onClick={() => setLightboxImg(item.url)}
                title={`Captured: ${item.name || item.filename}`}
              >
                <img src={item.url} alt={item.name || "Snapshot"} className="snapshot-thumb-img" />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Lightbox Modal for Snapshot Inspection */}
      {lightboxImg && (
        <div className="camera-lightbox-modal" onClick={() => setLightboxImg(null)}>
          <div className="camera-lightbox-content" onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: "12px 16px", display: "flex", justifyContent: "space-between", alignItems: "center", background: "#16203a", borderBottom: "1px solid rgba(34,211,238,0.3)" }}>
              <span style={{ color: "#ffffff", fontWeight: 700, fontSize: "14px", display: "flex", alignItems: "center", gap: "6px" }}>
                <Camera size={15} style={{ color: "#22d3ee" }} /> Mission Snapshot View
              </span>
              <div style={{ display: "flex", gap: "8px" }}>
                <a
                  href={lightboxImg}
                  download="subsea-snapshot.jpg"
                  style={{ ...btnGhost, padding: "5px 10px", textDecoration: "none", fontSize: "12px" }}
                >
                  <Download size={13} /> Save
                </a>
                <button
                  onClick={() => setLightboxImg(null)}
                  style={{ background: "transparent", border: "none", color: "#93a1bc", cursor: "pointer" }}
                >
                  <X size={18} />
                </button>
              </div>
            </div>
            <div style={{ padding: "16px", background: "#030712", display: "flex", justifyContent: "center", alignItems: "center", maxHeight: "70vh", overflow: "hidden" }}>
              <img src={lightboxImg} alt="Preview" style={{ maxWidth: "100%", maxHeight: "68vh", objectFit: "contain", borderRadius: "8px" }} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}


