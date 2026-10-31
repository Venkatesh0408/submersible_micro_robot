import { useState, useRef, useEffect, useCallback } from "react";
import { useMission } from "../context/MissionContext";
import { toast } from "./Toast";
import {
    captureImage,
    armPropulsion,
    disarmPropulsion,
    clearEstop,
    testMotor,
    testServo,
    getHardwareStatus
} from "../services/api";
import {
    Sliders,
    Shield,
    ShieldAlert,
    AlertOctagon,
    Play,
    Square,
    Pause,
    Home,
    Camera,
    Compass,
    Activity,
    ChevronDown,
    ChevronUp,
    Zap
} from "lucide-react";

export default function MissionToolbar() {
    const {
        robot,
        missionStarted,
        missionPaused,
        startMission,
        pauseMission,
        resumeMission,
        stopMission,
        emergencyStop,
        returnHome,
        manualMove,
    } = useMission();

    // Unified Movement & Direction State
    const [activeDir, setActiveDir] = useState(null);
    const [movementStatus, setMovementStatus] = useState("IDLE");
    const moveIntervalRef = useRef(null);

    // Hardware Abstraction Layer (HAL) States
    const [hwArmed, setHwArmed] = useState(false);
    const [hwEstop, setHwEstop] = useState(false);
    const [hwMode, setHwMode] = useState("SIMULATION");
    const [m1Pwm, setM1Pwm] = useState(90);
    const [s1Angle, setS1Angle] = useState(90);
    const [showBenchTools, setShowBenchTools] = useState(false);
    const [isExecutingCmd, setIsExecutingCmd] = useState(false);

    // Sync hardware diagnostics status periodically
    useEffect(() => {
        let isMounted = true;
        const syncHw = async () => {
            try {
                const res = await getHardwareStatus();
                if (isMounted && res) {
                    setHwArmed(Boolean(res.unified?.armed));
                    setHwEstop(Boolean(res.unified?.estop));
                    setHwMode(res.mode || "SIMULATION");
                }
            } catch {
                // Ignore background poll errors in simulation
            }
        };

        syncHw();
        const timer = setInterval(syncHw, 3000);
        return () => {
            isMounted = false;
            clearInterval(timer);
        };
    }, []);

    // Mission Control Handlers
    function startHandler() {
        startMission();
        setMovementStatus("SURVEYING");
        toast.success("Autonomous mission survey initiated", { title: "Mission Control" });
    }

    function pauseHandler() {
        if (missionPaused) {
            resumeMission();
            setMovementStatus("SURVEYING");
            toast.info("Mission resumed");
        } else {
            pauseMission();
            setMovementStatus("PAUSED");
            toast.info("Mission paused");
        }
    }

    function stopHandler() {
        stopMission();
        setMovementStatus("STOPPED");
        toast.info("Mission stopped");
    }

    function homeHandler() {
        returnHome();
        setMovementStatus("RETURNING HOME");
        toast.info("Returning to home coordinates");
    }

    async function handleCapture() {
        toast.success("Image captured", { title: "Camera" });
        try { await captureImage(); } catch { /* demo mode */ }
    }

    async function handleEmergency() {
        emergencyStop();
        setHwEstop(true);
        setHwArmed(false);
        setMovementStatus("EMERGENCY STOP");
        try {
            await emergencyStop();
        } catch {}
        toast.error("EMERGENCY STOP ACTIVATED — Motors disarmed", { title: "Safety Halt" });
    }

    // Direction Movement Logic (WASD & Keyboard + D-Pad)
    const startMoving = useCallback((dir) => {
        if (moveIntervalRef.current) return;
        setActiveDir(dir);
        const label = dir === "up" ? "FORWARD" : dir === "down" ? "REVERSE" : dir === "left" ? "TURNING LEFT" : "TURNING RIGHT";
        setMovementStatus(label);
        manualMove(dir);
        moveIntervalRef.current = setInterval(() => {
            manualMove(dir);
        }, 100);
    }, [manualMove]);

    const stopMoving = useCallback(() => {
        if (moveIntervalRef.current) {
            clearInterval(moveIntervalRef.current);
            moveIntervalRef.current = null;
        }
        setActiveDir(null);
        if (movementStatus !== "SURVEYING" && movementStatus !== "EMERGENCY STOP") {
            setMovementStatus("IDLE");
        }
    }, [movementStatus]);

    // Keyboard bindings for seamless control at any time
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.repeat) return;
            switch(e.key) {
                case 'ArrowUp':
                case 'w':
                case 'W':
                    startMoving('up');
                    break;
                case 'ArrowDown':
                case 's':
                case 'S':
                    startMoving('down');
                    break;
                case 'ArrowLeft':
                case 'a':
                case 'A':
                    startMoving('left');
                    break;
                case 'ArrowRight':
                case 'd':
                case 'D':
                    startMoving('right');
                    break;
                case ' ':
                    handleEmergency();
                    break;
            }
        };

        const handleKeyUp = (e) => {
            switch(e.key) {
                case 'ArrowUp':
                case 'w':
                case 'W':
                case 'ArrowDown':
                case 's':
                case 'S':
                case 'ArrowLeft':
                case 'a':
                case 'A':
                case 'ArrowRight':
                case 'd':
                case 'D':
                    stopMoving();
                    break;
            }
        };

        window.addEventListener('keydown', handleKeyDown);
        window.addEventListener('keyup', handleKeyUp);

        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            window.removeEventListener('keyup', handleKeyUp);
            stopMoving();
        };
    }, [startMoving, stopMoving]);

    // Hardware Bench Actions
    const handleArmDisarm = async () => {
        setIsExecutingCmd(true);
        try {
            if (hwArmed) {
                const res = await disarmPropulsion();
                if (res?.success) {
                    setHwArmed(false);
                    toast.info("Propulsion disarmed (Safe 0 PWM)");
                } else {
                    toast.error(res?.message || "Disarm failed");
                }
            } else {
                const res = await armPropulsion();
                if (res?.success) {
                    setHwArmed(true);
                    toast.success("Propulsion ARMED for bench test");
                } else {
                    toast.warning(res?.message || "Cannot arm propulsion in simulation mode");
                }
            }
        } catch (err) {
            toast.error("Hardware communication failure");
        } finally {
            setIsExecutingCmd(false);
        }
    };

    const handleClearEstop = async () => {
        setIsExecutingCmd(true);
        try {
            const res = await clearEstop();
            if (res?.success) {
                setHwEstop(false);
                setMovementStatus("IDLE");
                toast.success("Emergency stop cleared");
            } else {
                toast.error(res?.message || "Could not clear ESTOP");
            }
        } catch {
            toast.error("Clear ESTOP failed");
        } finally {
            setIsExecutingCmd(false);
        }
    };

    const handlePulseMotor = async () => {
        setIsExecutingCmd(true);
        toast.info(`Triggering M1 thruster pulse (PWM: ${m1Pwm}, 500ms)...`);
        try {
            const res = await testMotor(1, m1Pwm, 500);
            if (res?.success) {
                toast.success("Motor pulse executed and confirmed");
            } else {
                toast.warning(res?.message || "Motor command rejected");
            }
        } catch {
            toast.error("Motor test request failed");
        } finally {
            setIsExecutingCmd(false);
        }
    };

    const handleSetServo = async () => {
        setIsExecutingCmd(true);
        toast.info(`Positioning S1 vectoring servo to ${s1Angle}°...`);
        try {
            const res = await testServo(1, s1Angle);
            if (res?.success) {
                toast.success(`Servo rotated to ${s1Angle}°`);
            } else {
                toast.warning(res?.message || "Servo command rejected");
            }
        } catch {
            toast.error("Servo test request failed");
        } finally {
            setIsExecutingCmd(false);
        }
    };

    return (
        <div className="mission-toolbar" style={{
            background: "linear-gradient(145deg, #16203a, #0e1524)",
            border: "1px solid rgba(18, 211, 224, 0.3)",
            borderRadius: "20px",
            padding: "18px",
            display: "flex",
            flexDirection: "column",
            gap: "14px",
            boxShadow: "0 4px 20px rgba(0, 0, 0, 0.4)"
        }}>
            {/* Header: Unified Robot Control & Real-time Status */}
            <div style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                flexWrap: "wrap",
                gap: "10px",
                borderBottom: "1px solid rgba(34, 211, 238, 0.15)",
                paddingBottom: "12px"
            }}>
                <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Compass size={20} className="text-cyan-400" />
                    <h3 style={{ margin: 0, color: "#ffffff", fontSize: "16px", fontWeight: 700 }}>
                        Unified VSTY Robot Control
                    </h3>
                </div>

                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                    {/* Movement Status Pill */}
                    <span style={{
                        padding: "4px 10px",
                        borderRadius: "999px",
                        fontSize: "11px",
                        fontWeight: 700,
                        background: activeDir ? "rgba(34, 211, 238, 0.25)" : "rgba(30, 41, 59, 0.8)",
                        color: activeDir ? "#22d3ee" : "#94a3b8",
                        border: "1px solid rgba(34, 211, 238, 0.2)"
                    }}>
                        STATUS: {movementStatus}
                    </span>

                    {/* Propulsion Armed / Estop Status */}
                    <span style={{
                        padding: "4px 10px",
                        borderRadius: "999px",
                        fontSize: "11px",
                        fontWeight: 700,
                        background: hwEstop ? "rgba(239, 68, 68, 0.2)" : hwArmed ? "rgba(234, 179, 8, 0.2)" : "rgba(34, 197, 94, 0.15)",
                        color: hwEstop ? "#f87171" : hwArmed ? "#fde047" : "#4ade80",
                        border: `1px solid ${hwEstop ? "#ef4444" : hwArmed ? "#eab308" : "#22c55e"}`
                    }}>
                        {hwEstop ? "ESTOP LATCHED" : hwArmed ? "ARMED (BENCH ONLY)" : "DISARMED (SAFE 0 PWM)"}
                    </span>
                </div>
            </div>

            {/* Central Controls: Direction D-Pad + Mission Actions */}
            <div style={{
                display: "flex",
                gap: "18px",
                alignItems: "center",
                flexWrap: "wrap",
                justifyContent: "space-between"
            }}>
                {/* 4-Way Tactical Direction D-Pad */}
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(3, 52px)",
                    gap: "6px",
                    margin: "0 auto"
                }}>
                    <div />
                    <button
                        style={{ ...dPadBtn, border: activeDir === "up" ? "2px solid #22d3ee" : dPadBtn.border }}
                        onPointerDown={() => startMoving("up")}
                        onPointerUp={stopMoving}
                        onPointerLeave={stopMoving}
                        title="Move Forward (W / ArrowUp)"
                    >
                        ▲
                    </button>
                    <div />
                    <button
                        style={{ ...dPadBtn, border: activeDir === "left" ? "2px solid #22d3ee" : dPadBtn.border }}
                        onPointerDown={() => startMoving("left")}
                        onPointerUp={stopMoving}
                        onPointerLeave={stopMoving}
                        title="Turn Left (A / ArrowLeft)"
                    >
                        ◀
                    </button>
                    <button
                        style={{ ...dPadBtn, border: activeDir === "down" ? "2px solid #22d3ee" : dPadBtn.border }}
                        onPointerDown={() => startMoving("down")}
                        onPointerUp={stopMoving}
                        onPointerLeave={stopMoving}
                        title="Move Reverse (S / ArrowDown)"
                    >
                        ▼
                    </button>
                    <button
                        style={{ ...dPadBtn, border: activeDir === "right" ? "2px solid #22d3ee" : dPadBtn.border }}
                        onPointerDown={() => startMoving("right")}
                        onPointerUp={stopMoving}
                        onPointerLeave={stopMoving}
                        title="Turn Right (D / ArrowRight)"
                    >
                        ▶
                    </button>
                </div>

                {/* Primary Mission Command Grid */}
                <div style={{ display: "flex", flexDirection: "column", gap: "8px", flex: 1, minWidth: "220px" }}>
                    <div style={{ display: "flex", gap: "8px" }}>
                        <button
                            style={{ ...actionBtn(missionStarted ? "#0284c7" : "#16a34a"), flex: 1 }}
                            onClick={missionStarted ? stopHandler : startHandler}
                        >
                            {missionStarted ? <Square size={14} /> : <Play size={14} />}
                            {missionStarted ? "STOP" : "START SURVEY"}
                        </button>
                        <button
                            style={{ ...actionBtn(missionPaused ? "#0284c7" : "#d97706"), flex: 1, opacity: missionStarted ? 1 : 0.5 }}
                            onClick={pauseHandler}
                            disabled={!missionStarted}
                        >
                            <Pause size={14} />
                            {missionPaused ? "RESUME" : "PAUSE"}
                        </button>
                    </div>

                    <div style={{ display: "flex", gap: "8px" }}>
                        <button style={{ ...actionBtn("#0891b2"), flex: 1 }} onClick={homeHandler}>
                            <Home size={14} /> RETURN HOME
                        </button>
                        <button style={{ ...actionBtn("#0284c7"), flex: 1 }} onClick={handleCapture}>
                            <Camera size={14} /> SNAPSHOT
                        </button>
                    </div>

                    {/* High-Visibility Emergency Stop */}
                    <button
                        style={{
                            ...actionBtn("#dc2626"),
                            background: "linear-gradient(135deg, #ef4444, #b91c1c)",
                            boxShadow: "0 0 15px rgba(239, 68, 68, 0.4)",
                            border: "1px solid #f87171"
                        }}
                        onClick={handleEmergency}
                    >
                        <AlertOctagon size={16} /> EMERGENCY STOP
                    </button>
                </div>
            </div>

            {/* Subsystem & Bench Hardware Abstraction Layer (HAL) Toggle */}
            <div style={{
                borderTop: "1px solid rgba(34, 211, 238, 0.15)",
                paddingTop: "10px"
            }}>
                <button
                    onClick={() => setShowBenchTools(!showBenchTools)}
                    style={{
                        background: "transparent",
                        border: "none",
                        color: "#93a1bc",
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "space-between",
                        width: "100%",
                        fontSize: "12px",
                        fontWeight: 600,
                        cursor: "pointer",
                        padding: "4px 0"
                    }}
                >
                    <span style={{ display: "flex", alignItems: "center", gap: "6px" }}>
                        <Sliders size={14} style={{ color: "#22d3ee" }} />
                        Hardware Subsystems & Thruster Bench Diagnostics
                    </span>
                    {showBenchTools ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                </button>

                {showBenchTools && (
                    <div style={{
                        marginTop: "10px",
                        background: "#080e1a",
                        borderRadius: "12px",
                        padding: "12px",
                        display: "flex",
                        flexDirection: "column",
                        gap: "10px",
                        border: "1px solid rgba(255,255,255,0.06)"
                    }}>
                        {/* Arm / Disarm & Clear ESTOP Safety Row */}
                        <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
                            <button
                                onClick={handleArmDisarm}
                                disabled={isExecutingCmd}
                                style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: "6px",
                                    padding: "6px 12px",
                                    borderRadius: "8px",
                                    fontSize: "11.5px",
                                    fontWeight: 700,
                                    cursor: isExecutingCmd ? "not-allowed" : "pointer",
                                    background: hwArmed ? "rgba(234, 179, 8, 0.2)" : "rgba(34, 197, 94, 0.2)",
                                    border: `1px solid ${hwArmed ? "#eab308" : "#22c55e"}`,
                                    color: hwArmed ? "#fde047" : "#4ade80"
                                }}
                            >
                                <Shield size={13} />
                                {hwArmed ? "Disarm Propulsion" : "Arm Propulsion (Bench)"}
                            </button>

                            {hwEstop && (
                                <button
                                    onClick={handleClearEstop}
                                    disabled={isExecutingCmd}
                                    style={{
                                        display: "inline-flex",
                                        alignItems: "center",
                                        gap: "6px",
                                        padding: "6px 12px",
                                        borderRadius: "8px",
                                        fontSize: "11.5px",
                                        fontWeight: 700,
                                        cursor: isExecutingCmd ? "not-allowed" : "pointer",
                                        background: "rgba(59, 130, 246, 0.2)",
                                        border: "1px solid #3b82f6",
                                        color: "#60a5fa"
                                    }}
                                >
                                    <ShieldAlert size={13} /> Clear Latch
                                </button>
                            )}

                            <span style={{ fontSize: "11px", color: "#64748b", marginLeft: "auto" }}>
                                Mode: <b style={{ color: hwMode === "REAL" ? "#f59e0b" : "#38bdf8" }}>{hwMode}</b>
                            </span>
                        </div>

                        {/* Stage-1 Thruster M1 Control */}
                        <div style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            flexWrap: "wrap",
                            fontSize: "12px",
                            color: "#cbd5e1"
                        }}>
                            <span style={{ width: "90px", fontWeight: 600 }}>M1 PWM ({m1Pwm}):</span>
                            <input
                                type="range"
                                min={0}
                                max={140}
                                value={m1Pwm}
                                onChange={(e) => setM1Pwm(Number(e.target.value))}
                                style={{ flex: 1, minWidth: "120px" }}
                            />
                            <button
                                onClick={handlePulseMotor}
                                disabled={isExecutingCmd || !hwArmed}
                                style={{
                                    padding: "5px 10px",
                                    borderRadius: "6px",
                                    border: "1px solid #38bdf8",
                                    background: "rgba(56, 189, 248, 0.15)",
                                    color: "#38bdf8",
                                    fontSize: "11px",
                                    fontWeight: 700,
                                    cursor: (!hwArmed || isExecutingCmd) ? "not-allowed" : "pointer",
                                    opacity: hwArmed ? 1 : 0.5
                                }}
                            >
                                Pulse M1 (500ms)
                            </button>
                        </div>

                        {/* Stage-1 Vectoring Servo S1 Positioning */}
                        <div style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "10px",
                            flexWrap: "wrap",
                            fontSize: "12px",
                            color: "#cbd5e1"
                        }}>
                            <span style={{ width: "90px", fontWeight: 600 }}>S1 Servo ({s1Angle}°):</span>
                            <input
                                type="range"
                                min={45}
                                max={135}
                                value={s1Angle}
                                onChange={(e) => setS1Angle(Number(e.target.value))}
                                style={{ flex: 1, minWidth: "120px" }}
                            />
                            <button
                                onClick={handleSetServo}
                                disabled={isExecutingCmd}
                                style={{
                                    padding: "5px 10px",
                                    borderRadius: "6px",
                                    border: "1px solid #34d399",
                                    background: "rgba(52, 211, 153, 0.15)",
                                    color: "#34d399",
                                    fontSize: "11px",
                                    fontWeight: 700,
                                    cursor: isExecutingCmd ? "not-allowed" : "pointer"
                                }}
                            >
                                Set Angle
                            </button>
                        </div>

                        {/* Hardware Safety Callout */}
                        <div style={{
                            fontSize: "10.5px",
                            color: "#94a3b8",
                            background: "rgba(15, 23, 42, 0.6)",
                            padding: "6px 8px",
                            borderRadius: "6px"
                        }}>
                            ℹ️ Stage-1 hardware: Arduino UNO R3 (M1 thruster + S1 servo active). Full 4-thruster propulsion safely gated until multi-L298N hardware confirmed.
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

const dPadBtn = {
    background: "linear-gradient(135deg, #1e293b, #0f172a)",
    border: "1px solid rgba(34, 211, 238, 0.3)",
    borderRadius: "10px",
    color: "#22d3ee",
    fontSize: "18px",
    height: "52px",
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 10px rgba(0,0,0,0.3)",
    transition: "all 0.15s ease",
    userSelect: "none"
};

const actionBtn = (color) => ({
    background: `linear-gradient(135deg, ${color}, ${color}cc)`,
    color: "#ffffff",
    border: "none",
    padding: "10px 14px",
    borderRadius: "10px",
    fontWeight: 700,
    fontSize: "12px",
    cursor: "pointer",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    gap: "6px",
    boxShadow: `0 3px 8px ${color}33`,
    transition: "all 0.15s ease"
});
