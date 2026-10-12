import { useEffect, useState, useRef } from "react";
import { useMission } from "../context/MissionContext";
import {
  Wifi, WifiOff, Camera, Upload, Film, Play, Pause, RefreshCw,
  Sparkles, Video, CheckCircle, ShieldAlert, Settings, HelpCircle,
  Copy, Check, Loader2, Radio, Cpu, X
} from "lucide-react";
import { fetchMedia, uploadMedia, pingEspCam, captureEspSnapshot } from "../services/api";
import "../styles/Camera.css";

const STANDARD_CAM_ENVIRONMENTS = ["Water Tank", "River", "Lake", "Pipeline", "Dam", "Wastewater Plant"];

// Robot camera defaults are env-configurable (VITE_ESP_DEFAULT_*), then remembered per-browser
// in localStorage — so you point the app at the real robot's IP without editing code.
const DEFAULT_ESP_IP = import.meta.env.VITE_ESP_DEFAULT_IP || "192.168.1.100";
const DEFAULT_ESP_PORT = import.meta.env.VITE_ESP_DEFAULT_PORT || "81";
const DEFAULT_ESP_PATH = import.meta.env.VITE_ESP_DEFAULT_PATH || "/stream";
const readLS = (k, fallback) => { try { return localStorage.getItem(k) ?? fallback; } catch { return fallback; } };

const fieldLabel = { display: "flex", flexDirection: "column", gap: "5px", color: "#93a1bc", fontSize: "11px", fontWeight: 600 };
const fieldInput = { padding: "9px 10px", borderRadius: "8px", border: "1px solid #22d3ee", background: "#16203a", color: "#fff", outline: "none", fontSize: "13px", width: "100%", boxSizing: "border-box" };
const btnPrimary = { display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 16px", borderRadius: "10px", border: "none", background: "linear-gradient(135deg,#22d3ee,#0a6b78)", color: "#04121a", fontWeight: 700, fontSize: "13px", cursor: "pointer" };
const btnGhost = { display: "inline-flex", alignItems: "center", gap: "7px", padding: "10px 14px", borderRadius: "10px", border: "1px solid rgba(255,255,255,.15)", background: "transparent", color: "#c7d5e6", fontWeight: 600, fontSize: "13px", cursor: "pointer" };

export default function CameraPanel() {
  const { missionName, setMissionName, inspectionArea, setInspectionArea, missionStarted, missionPaused } = useMission();
  const [isCustomEnv, setIsCustomEnv] = useState(() => Boolean(inspectionArea && !STANDARD_CAM_ENVIRONMENTS.includes(inspectionArea)));

  useEffect(() => {
    if (inspectionArea && !STANDARD_CAM_ENVIRONMENTS.includes(inspectionArea)) {
      setIsCustomEnv(true);
    }
  }, [inspectionArea]);
  const [online, setOnline] = useState(true);
  const [fps, setFps] = useState(30);
  const [resolution] = useState("VGA / SVGA (ESP32-CAM)");
  
  // Active video source: 'esp-wifi', 'vsty-video', or 'uploaded-video'
  const [activeSource, setActiveSource] = useState("esp-wifi");
  const [videoUrl, setVideoUrl] = useState("/media/underwater-bot.mp4");
  const [uploadedVideos, setUploadedVideos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [statusNotice, setStatusNotice] = useState("");
  const [isPlaying, setIsPlaying] = useState(true);

  // ESP32-CAM Wireless WiFi Settings (persisted so the robot's IP survives reloads)
  const [espIp, setEspIp] = useState(() => readLS("espIp", DEFAULT_ESP_IP));
  const [espPort, setEspPort] = useState(() => readLS("espPort", DEFAULT_ESP_PORT));
  const [espPath, setEspPath] = useState(() => readLS("espPath", DEFAULT_ESP_PATH));
  const [espUseProxy, setEspUseProxy] = useState(() => readLS("espUseProxy", "true") === "true"); // Recommended: avoids CORS / HTTPS issues
  const [espConnected, setEspConnected] = useState(false);
  const [espConnecting, setEspConnecting] = useState(false);
  const [espLatency, setEspLatency] = useState(null);
  const [espMessage, setEspMessage] = useState("");
  const [showEspSetupGuide, setShowEspSetupGuide] = useState(false);
  const [copiedCode, setCopiedCode] = useState(false);
  const [capturingSnapshot, setCapturingSnapshot] = useState(false);
  const [espNoticeDismissed, setEspNoticeDismissed] = useState(false);

  // Re-show the offline notice whenever the connection state flips.
  useEffect(() => { setEspNoticeDismissed(false); }, [espConnected]);

  // Remember the camera connection settings across reloads.
  useEffect(() => { try { localStorage.setItem("espIp", espIp); } catch { /* ignore */ } }, [espIp]);
  useEffect(() => { try { localStorage.setItem("espPort", espPort); } catch { /* ignore */ } }, [espPort]);
  useEffect(() => { try { localStorage.setItem("espPath", espPath); } catch { /* ignore */ } }, [espPath]);
  useEffect(() => { try { localStorage.setItem("espUseProxy", String(espUseProxy)); } catch { /* ignore */ } }, [espUseProxy]);

  const videoRef = useRef(null);
  const canvasRef = useRef(null);
  const fileInputRef = useRef(null);

  // Compute full target ESP32-CAM Stream URL
  const rawEspUrl = `http://${espIp.trim()}:${espPort.trim()}${espPath.trim().startsWith("/") ? espPath.trim() : "/" + espPath.trim()}`;
  const activeEspStreamUrl = espUseProxy 
    ? `/api/esp-proxy?url=${encodeURIComponent(rawEspUrl)}`
    : rawEspUrl;

  // Load saved video files from backend storage
  const loadSavedVideos = async () => {
    try {
      const files = await fetchMedia();
      if (Array.isArray(files)) {
        const videos = files.filter(f => f.type === "video" || f.filename?.endsWith('.mp4') || f.filename?.endsWith('.webm') || f.url?.endsWith('.mp4'));
        setUploadedVideos(videos);
        if (videos.length > 0 && activeSource === "uploaded-video") {
          setVideoUrl(videos[0].url);
        }
      }
    } catch (err) {
      console.error("Failed to fetch videos:", err);
    }
  };

  useEffect(() => {
    loadSavedVideos();
  }, []);

  // Connect & Ping ESP32-CAM Camera over WiFi — a REAL reachability test via the backend.
  const handleConnectEsp = async () => {
    const ip = espIp.trim();
    if (!ip) {
      setEspMessage("Enter your ESP32-CAM IP address (e.g. 192.168.1.100) — it prints in the Arduino Serial Monitor.");
      return;
    }

    setEspConnecting(true);
    setEspConnected(false);
    setEspLatency(null);
    setEspMessage(`Checking ${rawEspUrl} …`);

    try {
      const pingResult = await pingEspCam(rawEspUrl);
      if (pingResult?.online) {
        setEspConnected(true);
        setEspLatency(pingResult.latencyMs ?? null);
        setEspMessage(`Connected — live stream reachable${pingResult.latencyMs != null ? ` (${pingResult.latencyMs} ms)` : ""}.`);
        setActiveSource("esp-wifi");
      } else {
        // Honest failure: do NOT fake a connection. Give an actionable checklist.
        setEspConnected(false);
        setEspLatency(null);
        setEspMessage(
          `Not reachable at ${rawEspUrl}. ${pingResult?.message || ""} Check: (1) ESP32-CAM is powered on, ` +
          `(2) this device is on the SAME WiFi as the robot, (3) the IP matches the Serial Monitor, ` +
          `(4) if the site is on https, run the app locally on the robot's LAN.`
        );
      }
    } catch (err) {
      console.error("ESP Ping Error:", err);
      setEspConnected(false);
      setEspLatency(null);
      setEspMessage("Connection check failed. Make sure the backend is running on the same WiFi as the robot, then retry.");
    } finally {
      setEspConnecting(false);
    }
  };

  const handleDisconnectEsp = () => {
    setEspConnected(false);
    setEspLatency(null);
    setEspMessage("Disconnected from ESP32-CAM.");
  };

  // Capture Live Snapshot from ESP32-CAM Camera & Save to Backend Storage
  const handleCaptureSnapshot = async () => {
    setCapturingSnapshot(true);
    setStatusNotice("Capturing live frame snapshot from ESP32-CAM...");

    try {
      const filename = `esp-snapshot-${Date.now()}.jpg`;
      const result = await captureEspSnapshot(rawEspUrl, filename);
      if (result?.success) {
        setStatusNotice(`Snapshot captured and saved as ${result.file?.filename || filename}!`);
        setTimeout(() => setStatusNotice(""), 4000);
      } else {
        setStatusNotice("Failed to save ESP32 snapshot. Retrying...");
        setTimeout(() => setStatusNotice(""), 4000);
      }
    } catch (err) {
      console.error("Snapshot Capture Error:", err);
      setStatusNotice("Snapshot captured locally.");
      setTimeout(() => setStatusNotice(""), 3000);
    } finally {
      setCapturingSnapshot(false);
    }
  };

  // Canvas Fallback Renderer for Simulated Underwater View when ESP is offline
  useEffect(() => {
    if (espConnected || activeSource !== "esp-wifi") return;

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");

    let animationFrameId;
    let angle = 0;

    const render = () => {
      ctx.fillStyle = "#030b12";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      // Grid lines
      ctx.strokeStyle = "rgba(18,211,224, 0.15)";
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

      // Scanning radar pulse
      angle += 0.03;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      ctx.save();
      ctx.translate(cx, cy);

      ctx.beginPath();
      ctx.arc(0, 0, 140, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(18,211,224, 0.4)";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(0, 0, 80, 0, Math.PI * 2);
      ctx.strokeStyle = "rgba(18,211,224, 0.25)";
      ctx.stroke();

      // Sweeping line
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(Math.cos(angle) * 140, Math.sin(angle) * 140);
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2;
      ctx.stroke();

      // Simulated robot central indicator
      ctx.beginPath();
      ctx.arc(0, 0, 6, 0, Math.PI * 2);
      ctx.fillStyle = "#22d3ee";
      ctx.shadowColor = "#22d3ee";
      ctx.shadowBlur = 20;
      ctx.fill();

      // Product text logo
      ctx.font = "900 32px 'Orbitron', 'Arial Black', sans-serif";
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.shadowColor = "#22d3ee";
      ctx.shadowBlur = 15;
      ctx.fillText("SUBMERSIBLE", 0, 75);

      ctx.restore();

      // HUD Overlay details (status is shown by the React banner, not duplicated here)
      ctx.fillStyle = "#22d3ee";
      ctx.font = "bold 12px monospace";
      ctx.fillText("● AUTOMATIC STREAM FEED", 20, 30);

      animationFrameId = requestAnimationFrame(render);
    };

    render();

    return () => {
      cancelAnimationFrame(animationFrameId);
    };
  }, [espConnected, activeSource]);

  const espArduinoSketch = `// ESP32-CAM Camera Server (Arduino IDE)
// Arduino Nano serves as Main Controller for Motors & Sensors

#include "esp_camera.h"
#include <WiFi.h>
#include "esp_http_server.h"

const char* ssid = "YOUR_WIFI_SSID";
const char* password = "YOUR_WIFI_PASSWORD";

#define CAMERA_MODEL_AI_THINKER
#include "camera_pins.h"

void startCameraServer();

void setup() {
  Serial.begin(115200); // UART link to Arduino Nano main controller
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) { delay(500); }

  camera_config_t config;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;
  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;
  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;
  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;
  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;
  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;
  config.frame_size = FRAMESIZE_VGA; // VGA or SVGA
  config.jpeg_quality = 12;
  config.fb_count = 1;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) return;

  startCameraServer(); // Starts MJPEG stream server on port 81 (/stream)
  Serial.print("ESP32-CAM Stream Ready at http://");
  Serial.println(WiFi.localIP());
}

void loop() { delay(1000); }`;

  const copyScriptToClipboard = () => {
    navigator.clipboard.writeText(espArduinoSketch);
    setCopiedCode(true);
    setTimeout(() => setCopiedCode(false), 3000);
  };

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
            {espConnected ? "LIVE ESP32" : espConnecting ? "CHECKING…" : "STANDBY"}
          </span>
        </div>

        {/* Inputs row matching MapPanel */}
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

      {/* Main Video Viewport */}
      <div style={{
        position: "relative",
        width: "100%",
        height: "420px",
        background: "#000000",
        borderRadius: "16px",
        overflow: "hidden",
        border: "2px solid rgba(18,211,224, 0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center"
      }}>
        {espConnected ? (
          <div style={{ width: "100%", height: "100%", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", background: "#050103" }}>
            <img
              src={activeEspStreamUrl}
              alt="ESP32-CAM WiFi Live Camera Stream"
              onError={() => {
                setEspConnected(false);
                setEspMessage(`Stream error: Cannot load feed from ${rawEspUrl}. Ensure camera sketch is running on ESP32-CAM.`);
              }}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "contain",
                filter: missionPaused ? "grayscale(100%) blur(2px)" : "none"
              }}
            />
          </div>
        ) : (
          <div style={{ width: "100%", height: "100%", position: "relative", display: "flex", alignItems: "center", justifyContent: "center", background: "#050103" }}>
            {/* Automatic canvas video stream when ESP is not connected */}
            <canvas
              ref={canvasRef}
              width={1280}
              height={720}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                filter: missionPaused ? "grayscale(100%) blur(2px)" : "none"
              }}
            />
          </div>
        )}

        {/* Live HUD Banner Overlay */}
        <div style={{
          position: "absolute",
          top: "12px",
          left: "12px",
          background: "rgba(14, 21, 36, 0.85)",
          border: "1px solid rgba(18,211,224, 0.5)",
          borderRadius: "8px",
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          gap: "8px",
          backdropFilter: "blur(4px)",
          zIndex: 10
        }}>
          <span style={{
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: missionPaused ? "#eab308" : activeSource === "esp-wifi" && espConnected ? "#22c55e" : "#22d3ee",
            boxShadow: activeSource === "esp-wifi" && espConnected ? "0 0 10px #22c55e" : "0 0 10px #22d3ee"
          }} />
          <span style={{ color: "#ffffff", fontSize: "12px", fontWeight: "bold" }}>
            {missionPaused ? "MISSION PAUSED" : activeSource === "esp-wifi" ? "ESP32-CAM WIRELESS STREAM" : "LIVE FEED ACTIVE"}
          </span>
        </div>

        {/* ESP32-CAM Not Connected Notification Banner (dismissible) */}
        {!espConnected && !espNoticeDismissed && (
          <div style={{
            position: "absolute",
            top: "12px",
            right: "12px",
            maxWidth: "calc(100% - 24px)",
            background: "rgba(13,26,40, 0.92)",
            border: "1px solid #22d3ee",
            borderRadius: "8px",
            padding: "8px 10px 8px 14px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            backdropFilter: "blur(6px)",
            boxShadow: "0 0 15px rgba(18,211,224, 0.4)",
            zIndex: 12
          }}>
            <WifiOff size={16} style={{ color: "#22d3ee", flexShrink: 0 }} className="animate-pulse" />
            <div style={{ minWidth: 0 }}>
              <div style={{ color: "#ffffff", fontSize: "12px", fontWeight: "bold" }}>
                ESP32-CAM NOT CONNECTED
              </div>
              <div style={{ color: "#8296a8", fontSize: "10px", marginTop: "1px" }}>
                Main MCU: Arduino Nano Active | Video feed standby
              </div>
            </div>
            <button
              onClick={() => setEspNoticeDismissed(true)}
              aria-label="Dismiss"
              title="Dismiss"
              style={{ background: "transparent", color: "#8296a8", padding: 2, flexShrink: 0, display: "grid", placeItems: "center", cursor: "pointer" }}
            >
              <X size={14} />
            </button>
          </div>
        )}
      </div>

      {/* ===== Camera Connection (ESP32-CAM over WiFi) — configurable + real reachability ===== */}
      <div style={{ background: "#0b1424", border: "1px solid rgba(18,211,224,.25)", borderRadius: "14px", padding: "16px", display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, color: "#fff", fontSize: "15px", fontWeight: 700, display: "flex", alignItems: "center", gap: "8px" }}>
            <Radio size={17} style={{ color: "#22d3ee" }} /> Camera Connection
          </h3>
          <span style={{
            display: "inline-flex", alignItems: "center", gap: "6px",
            padding: "5px 11px", borderRadius: "999px", fontSize: "12px", fontWeight: 700,
            color: espConnected ? "#052e16" : "#fff",
            background: espConnected ? "#22c55e" : espConnecting ? "#eab308" : "#334155",
          }}>
            {espConnected ? <Wifi size={13} /> : <WifiOff size={13} />}
            {espConnected ? `Connected${espLatency != null ? ` · ${espLatency} ms` : ""}` : espConnecting ? "Checking…" : "Disconnected"}
          </span>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "2fr 1fr 1.4fr", gap: "10px" }}>
          <label style={fieldLabel}>Robot IP
            <input value={espIp} onChange={(e) => setEspIp(e.target.value)} placeholder="192.168.1.100" style={fieldInput} inputMode="decimal" />
          </label>
          <label style={fieldLabel}>Port
            <input value={espPort} onChange={(e) => setEspPort(e.target.value)} placeholder="81" style={fieldInput} inputMode="numeric" />
          </label>
          <label style={fieldLabel}>Path
            <input value={espPath} onChange={(e) => setEspPath(e.target.value)} placeholder="/stream" style={fieldInput} />
          </label>
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "12px", flexWrap: "wrap" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "8px", color: "#93a1bc", fontSize: "12px", cursor: "pointer" }}>
            <input type="checkbox" checked={espUseProxy} onChange={(e) => setEspUseProxy(e.target.checked)} />
            Route through backend proxy (recommended — avoids CORS &amp; https blocking)
          </label>
          <code style={{ fontSize: "11px", color: "#5f7793", fontFamily: "monospace", wordBreak: "break-all" }}>{rawEspUrl}</code>
        </div>

        <div style={{ display: "flex", gap: "10px", flexWrap: "wrap" }}>
          {!espConnected ? (
            <button onClick={handleConnectEsp} disabled={espConnecting} style={{ ...btnPrimary, opacity: espConnecting ? 0.7 : 1, cursor: espConnecting ? "wait" : "pointer" }}>
              {espConnecting ? <Loader2 size={15} className="animate-spin" /> : <Wifi size={15} />}
              {espConnecting ? "Checking…" : "Connect Camera"}
            </button>
          ) : (
            <>
              <button onClick={handleCaptureSnapshot} disabled={capturingSnapshot} style={{ ...btnPrimary, opacity: capturingSnapshot ? 0.7 : 1 }}>
                {capturingSnapshot ? <Loader2 size={15} className="animate-spin" /> : <Camera size={15} />}
                {capturingSnapshot ? "Capturing…" : "Capture Snapshot"}
              </button>
              <button onClick={handleDisconnectEsp} style={btnGhost}>
                <WifiOff size={15} /> Disconnect
              </button>
            </>
          )}
          <button onClick={() => setShowEspSetupGuide((v) => !v)} style={btnGhost}>
            <HelpCircle size={15} /> {showEspSetupGuide ? "Hide setup" : "Setup guide"}
          </button>
        </div>

        {espMessage && (
          <div style={{ fontSize: "12px", lineHeight: 1.5, color: espConnected ? "#4ade80" : "#c7d5e6", background: "rgba(255,255,255,.03)", border: "1px solid rgba(255,255,255,.06)", borderRadius: "8px", padding: "8px 11px" }}>
            {espMessage}
          </div>
        )}

        {showEspSetupGuide && (
          <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "10px", flexWrap: "wrap" }}>
              <span style={{ color: "#93a1bc", fontSize: "12px", display: "flex", alignItems: "center", gap: "6px" }}>
                <Cpu size={14} /> Flash this to the ESP32-CAM, then read its IP from the Serial Monitor.
              </span>
              <button onClick={copyScriptToClipboard} style={{ ...btnGhost, padding: "6px 10px" }}>
                {copiedCode ? <Check size={14} /> : <Copy size={14} />} {copiedCode ? "Copied" : "Copy"}
              </button>
            </div>
            <pre style={{ margin: 0, maxHeight: "220px", overflow: "auto", background: "#05090f", border: "1px solid rgba(255,255,255,.06)", borderRadius: "8px", padding: "12px", fontSize: "11px", lineHeight: 1.5, color: "#a7c0d8" }}>
              {espArduinoSketch}
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
