import { useState } from "react";
import { Info, ChevronDown, ChevronUp, Cpu, Activity, AlertTriangle } from "lucide-react";
import "../styles/SensorCard.css";

function SensorCard({
  title,
  value,
  status = "OK",
  unit = "",
  error,
  solution,
  simulated,
  sensorState,
  rawAdc,
  voltage,
  calibrated,
  hardwareMode
}) {
  const [expanded, setExpanded] = useState(false);

  const getColor = () => {
    switch (status) {
      case "OK":
        return "#22c55e";
      case "WARNING":
        return "#ffb703";
      case "ERROR":
        return "#ff4d6d";
      default:
        return "#22d3ee";
    }
  };

  const isSimulated = simulated ?? (title?.toLowerCase().includes("simulated") || hardwareMode === "SIMULATION");
  const isNotInstalled = sensorState === "NOT_INSTALLED" || value === "N/A";

  return (
    <div
      className={`sensor-card ${expanded ? "sensor-card--expanded" : ""}`}
      onClick={() => setExpanded(!expanded)}
      style={{
        border: status === "ERROR"
          ? "1px solid #ff4d6d"
          : status === "WARNING"
          ? "1px solid #ffb703"
          : "1px solid rgba(18,211,224,0.3)",
        backgroundColor: status === "ERROR"
          ? "rgba(255, 77, 109, 0.12)"
          : status === "WARNING"
          ? "rgba(255, 183, 3, 0.08)"
          : "#16203a",
        height: expanded ? "auto" : "150px",
        minHeight: "150px",
        transition: "all 0.3s cubic-bezier(0.16, 1, 0.3, 1)",
        position: "relative",
        overflow: "hidden"
      }}
    >
      {/* Top Header */}
      <div className="sensor-header" style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
          <span className="sensor-title" style={{ fontSize: "15px", fontWeight: 700, color: "#ffffff" }}>
            {title}
          </span>
          {/* Honest status badge */}
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            {isNotInstalled ? (
              <span style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "10px", background: "rgba(255,183,3,0.18)", color: "#ffb703", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <AlertTriangle size={10} /> NOT INSTALLED
              </span>
            ) : isSimulated ? (
              <span style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "10px", background: "rgba(34,211,238,0.15)", color: "#22d3ee", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <Cpu size={10} /> SIMULATED
              </span>
            ) : (
              <span style={{ fontSize: "10px", padding: "2px 7px", borderRadius: "10px", background: "rgba(34,197,94,0.18)", color: "#4ade80", fontWeight: 700, display: "inline-flex", alignItems: "center", gap: "4px" }}>
                <Activity size={10} /> LIVE HW
              </span>
            )}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span
            className="sensor-indicator"
            style={{
              background: getColor(),
              boxShadow: `0 0 10px ${getColor()}`,
              width: "12px",
              height: "12px",
              borderRadius: "50%",
              flexShrink: 0
            }}
          />
          <button
            aria-label="Toggle Details"
            style={{
              background: "transparent",
              border: "none",
              color: "#93a1bc",
              cursor: "pointer",
              padding: "2px",
              display: "flex",
              alignItems: "center"
            }}
          >
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </button>
        </div>
      </div>

      {/* Main Sensor Value */}
      <div className="sensor-value" style={{ color: status === "ERROR" ? "#ff4d6d" : "#22d3ee", fontSize: "28px", fontWeight: "bold", margin: "8px 0" }}>
        {value}
        <span className="sensor-unit" style={{ fontSize: "16px", color: "#93a1bc", marginLeft: "6px" }}>
          {unit}
        </span>
      </div>

      {/* Mini interactive sparkline wave bar */}
      <div className="sensor-footer" style={{ height: "6px", background: "rgba(255,255,255,0.08)", borderRadius: "4px", overflow: "hidden" }}>
        <div
          className="sensor-progress"
          style={{
            width: value === "ERR" || isNotInstalled ? "25%" : "85%",
            background: getColor(),
            height: "100%",
            borderRadius: "4px",
            transition: "width 0.4s ease"
          }}
        />
      </div>

      {/* Expanded Interactive Diagnostics Drawer */}
      {expanded && (
        <div
          style={{
            marginTop: "14px",
            paddingTop: "12px",
            borderTop: "1px dashed rgba(255,255,255,0.12)",
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            fontSize: "12px"
          }}
          onClick={(e) => e.stopPropagation()}
        >
          {rawAdc !== undefined && rawAdc !== null && (
            <div style={{ display: "flex", justifyContent: "space-between", color: "#c7d5e6" }}>
              <span>Raw ADC Value:</span>
              <strong style={{ color: "#22d3ee", fontFamily: "monospace" }}>{rawAdc} / 1023</strong>
            </div>
          )}
          {voltage !== undefined && voltage !== null && (
            <div style={{ display: "flex", justifyContent: "space-between", color: "#c7d5e6" }}>
              <span>Signal Voltage:</span>
              <strong style={{ color: "#22d3ee", fontFamily: "monospace" }}>{voltage} V</strong>
            </div>
          )}
          {calibrated !== undefined && (
            <div style={{ display: "flex", justifyContent: "space-between", color: "#c7d5e6" }}>
              <span>Calibration Status:</span>
              <strong style={{ color: calibrated ? "#4ade80" : "#ffb703" }}>
                {calibrated ? "Calibrated (2-pt NTU)" : "Uncalibrated (Raw ADC)"}
              </strong>
            </div>
          )}
          {sensorState && (
            <div style={{ display: "flex", justifyContent: "space-between", color: "#c7d5e6" }}>
              <span>Telemetry State:</span>
              <span style={{ color: "#93a1bc", fontFamily: "monospace" }}>{sensorState}</span>
            </div>
          )}
          {error && (
            <div style={{ color: "#ff4d6d", background: "rgba(255,77,109,0.1)", padding: "6px 8px", borderRadius: "6px" }}>
              <strong>Diagnostics:</strong> {error}
            </div>
          )}
          {solution && (
            <div style={{ color: "#22d3ee", background: "rgba(34,211,238,0.1)", padding: "6px 8px", borderRadius: "6px" }}>
              <strong>Action:</strong> {solution}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default SensorCard;
