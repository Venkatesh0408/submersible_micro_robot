import { Suspense, Component, useEffect, useRef, useState, useCallback } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import {
    OrbitControls, Environment, Lightformer, ContactShadows,
    useGLTF, useProgress, AdaptiveDpr, AdaptiveEvents,
} from "@react-three/drei";
import { useReducedMotion } from "framer-motion";
import {
    Boxes, Box as BoxIcon, RotateCcw, RefreshCw, MousePointer2,
    X, TriangleAlert, Play, Pause
} from "lucide-react";
import * as THREE from "three";
import "../styles/RobotViewer.css";

const VIDEO_URL = "/videos/robot-assembly.mp4";
const ASSEMBLED_URL = "/models/robot-assembled.glb";
const EXPLODED_URL = "/models/robot-exploded.glb";
const DRACO = "/draco/"; // self-hosted decoder, no CDN
const POSTER = "/models/robot-poster.jpg"; // optional static fallback (degrades gracefully)

useGLTF.preload(ASSEMBLED_URL, DRACO);
useGLTF.preload(EXPLODED_URL, DRACO);

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function hasWebGL() {
    try {
        const c = document.createElement("canvas");
        return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch { return false; }
}

// One fused model: recenter onto the floor, clone materials so we can cross-fade opacity.
function Model({ url, active }) {
    const { scene } = useGLTF(url, DRACO);
    const opacity = useRef(active ? 1 : 0);
    const baseCenter = useRef(new THREE.Vector3());

    useEffect(() => {
        const box = new THREE.Box3().setFromObject(scene);
        const c = box.getCenter(new THREE.Vector3());
        baseCenter.current.copy(c);
        scene.position.set(-c.x, -box.min.y, -c.z); // centered on X/Z, resting on y=0
        scene.traverse((o) => {
            if (o.isMesh && o.material && !o.material.userData.__cf) {
                o.material = o.material.clone();
                o.material.userData.__cf = true;
                o.material.transparent = true;
                o.material.depthWrite = true;
                o.material.envMapIntensity = 0.9;
            }
        });
    }, [scene]);

    useFrame((state, delta) => {
        opacity.current = THREE.MathUtils.damp(opacity.current, active ? 1 : 0, 5, delta);
        scene.visible = opacity.current > 0.015;
        scene.traverse((o) => { if (o.isMesh && o.material) o.material.opacity = opacity.current; });
        const time = state.clock.getElapsedTime();
        const hoverOffset = Math.sin(time * 1.4) * 0.012;
        scene.position.y = -baseCenter.current.y + hoverOffset;
    });

    return <primitive object={scene} />;
}

// Camera framing animator: whenever exploded flips, glide between tight and exploded shot.
function Framing({ exploded, resetKey, reduce }) {
    const { camera, controls } = useThree();
    const anim = useRef(null);

    const ASSEMBLED_SHOT = useRef({
        target: new THREE.Vector3(0, 0.16, 0),
        cam: new THREE.Vector3(0.95, 0.58, 1.3),
    });
    const EXPLODED_SHOT = useRef({
        target: new THREE.Vector3(0, 0.22, 0),
        cam: new THREE.Vector3(1.4, 0.95, 1.95),
    });

    const triggerFly = useCallback((toShot, duration = 1.05) => {
        if (!controls) return;
        if (reduce) {
            controls.target.copy(toShot.target);
            camera.position.copy(toShot.cam);
            controls.update();
            return;
        }
        anim.current = {
            t: 0,
            dur: duration,
            fromT: controls.target.clone(),
            toT: toShot.target.clone(),
            fromC: camera.position.clone(),
            toC: toShot.cam.clone(),
        };
    }, [camera, controls, reduce]);

    useEffect(() => {
        if (!controls) return;
        triggerFly(exploded ? EXPLODED_SHOT.current : ASSEMBLED_SHOT.current, 0.95);
    }, [exploded, triggerFly, controls]);

    useEffect(() => {
        if (!controls || resetKey === 0) return;
        triggerFly(exploded ? EXPLODED_SHOT.current : ASSEMBLED_SHOT.current, 0.65);
    }, [resetKey, exploded, triggerFly, controls]);

    useFrame((_, delta) => {
        if (!anim.current || !controls) return;
        const a = anim.current;
        a.t = Math.min(1, a.t + delta / a.dur);
        const e = easeInOut(a.t);
        controls.target.lerpVectors(a.fromT, a.toT, e);
        camera.position.lerpVectors(a.fromC, a.toC, e);
        controls.update();
        if (a.t >= 1) anim.current = null;
    });

    return null;
}

function Scene({ exploded, resetKey, autoRotate, reduce, isMobile, controlsRef, onInteractStart, onInteractEnd }) {
    return (
        <>
            <hemisphereLight args={["#dff4ff", "#0a1420", 0.65]} />
            <directionalLight position={[4, 6, 3]} intensity={1.25} />
            <directionalLight position={[-4, 2, -3]} intensity={0.45} color="#8bb6ff" />

            <Environment resolution={256} frames={1}>
                <Lightformer intensity={2.2} position={[0, 4, -3]} scale={[10, 6, 1]} color="#cfeaff" />
                <Lightformer intensity={1.1} position={[-5, 2, 2]} scale={[6, 6, 1]} color="#7fb4ff" />
                <Lightformer intensity={0.9} position={[5, 1, 2]} scale={[6, 6, 1]} color="#ffffff" />
                <Lightformer intensity={0.6} position={[0, -3, 1]} scale={[10, 4, 1]} color="#22d3ee" />
            </Environment>

            <Suspense fallback={null}>
                <Model url={ASSEMBLED_URL} active={!exploded} />
                <Model url={EXPLODED_URL} active={exploded} />
                <Framing exploded={exploded} resetKey={resetKey} reduce={reduce} />
            </Suspense>

            <ContactShadows position={[0, 0, 0]} opacity={0.65} scale={4} blur={3} far={2.5} resolution={1024} color="#000208" />

            <OrbitControls
                ref={controlsRef} makeDefault
                enableDamping dampingFactor={0.08} rotateSpeed={0.55} zoomSpeed={0.7}
                enablePan={!isMobile} minDistance={0.4} maxDistance={10} maxPolarAngle={Math.PI * 0.92}
                autoRotate={autoRotate} autoRotateSpeed={0.8}
                onStart={onInteractStart} onEnd={onInteractEnd}
            />

            <AdaptiveDpr pixelated />
            <AdaptiveEvents />
        </>
    );
}

class GLBoundary extends Component {
    state = { error: false };
    static getDerivedStateFromError() { return { error: true }; }
    componentDidCatch(err) { console.error("RobotViewer WebGL/asset error:", err); }
    render() { return this.state.error ? this.props.fallback : this.props.children; }
}

function Fallback() {
    return (
        <div className="rv-fallback">
            <TriangleAlert size={30} />
            <p className="rv-fallback__head">3D preview unavailable on this device</p>
            <p className="rv-fallback__sub">Your browser or GPU can’t render WebGL here.</p>
            <img src={POSTER} alt="Submersible micro robot" className="rv-fallback__img" onError={(e) => { e.currentTarget.style.display = "none"; }} />
        </div>
    );
}

export default function RobotViewer() {
    const reduce = useReducedMotion();
    const controlsRef = useRef(null);
    const idleTimer = useRef(0);
    const [webgl] = useState(hasWebGL);
    const [exploded, setExploded] = useState(false);
    const [autoRotateOn, setAutoRotateOn] = useState(!reduce);
    const [isAutoAnimating, setIsAutoAnimating] = useState(false);

    // Video Player & Auto-Transition State
    const [isVideoActive, setIsVideoActive] = useState(true);
    const [isFading, setIsFading] = useState(false);
    const videoRef = useRef(null);
    const stageRef = useRef(null);

    // Auto-transition into 3D Orbit when assembly video completes
    const handleVideoEnded = useCallback(() => {
        setIsFading(true);
        setTimeout(() => {
            setIsVideoActive(false);
            setIsFading(false);
        }, 800);
    }, []);

    // Rewatch assembly video from the start
    const handleRewatch = useCallback(() => {
        setIsVideoActive(true);
        setIsFading(false);
        setTimeout(() => {
            if (videoRef.current) {
                videoRef.current.currentTime = 0;
                videoRef.current.play().catch(() => {});
            }
        }, 50);
    }, []);

    useEffect(() => {
        if (!isAutoAnimating) return;
        const timer = setInterval(() => {
            setExploded((prev) => !prev);
        }, 4500);
        return () => clearInterval(timer);
    }, [isAutoAnimating]);

    const toggleAutoAnimate = useCallback(() => {
        setIsAutoAnimating((prev) => {
            const next = !prev;
            if (next) {
                setAutoRotateOn(true);
            }
            return next;
        });
    }, []);

    const [interacting, setInteracting] = useState(false);
    const [resetKey, setResetKey] = useState(0);
    const [hint, setHint] = useState(true);
    const [frameloop, setFrameloop] = useState("always");
    const [isMobile, setIsMobile] = useState(false);

    const { active, progress } = useProgress();
    const [ready, setReady] = useState(false);
    useEffect(() => { if (!active && progress >= 100) setReady(true); }, [active, progress]);

    useEffect(() => setAutoRotateOn(!reduce), [reduce]);
    useEffect(() => setIsMobile(window.matchMedia("(pointer: coarse), (max-width: 640px)").matches), []);

    useEffect(() => {
        const onVis = () => setFrameloop(document.hidden ? "never" : "always");
        document.addEventListener("visibilitychange", onVis);
        return () => document.removeEventListener("visibilitychange", onVis);
    }, []);

    useEffect(() => () => {
        clearTimeout(idleTimer.current);
        useGLTF.clear([ASSEMBLED_URL, EXPLODED_URL]);
    }, []);

    const onInteractStart = useCallback(() => {
        setHint(false);
        clearTimeout(idleTimer.current);
        setInteracting(true);
    }, []);

    const onInteractEnd = useCallback(() => {
        clearTimeout(idleTimer.current);
        idleTimer.current = setTimeout(() => setInteracting(false), 2500);
    }, []);

    useEffect(() => {
        if (!hint) return;
        const t = setTimeout(() => setHint(false), 5000);
        return () => clearTimeout(t);
    }, [hint]);

    const resetView = useCallback(() => {
        controlsRef.current?.reset?.();
        setResetKey((k) => k + 1);
    }, []);

    const effectiveAutoRotate = autoRotateOn && !interacting && !reduce;

    return (
        <div className="rv">
            <div className="rv-stage" ref={stageRef}>
                {/* 1. Cinematic Fullscreen Assembly Video with Auto-Transition */}
                {isVideoActive && (
                    <div className={`rv-video-wrap${isFading ? " is-fading" : ""}`}>
                        <video
                            ref={videoRef}
                            src={VIDEO_URL}
                            playsInline
                            autoPlay
                            muted
                            onEnded={handleVideoEnded}
                            className="rv-video-element"
                        />
                    </div>
                )}

                {/* 2. Interactive 3D Model Orbit Canvas */}
                {!webgl ? (
                    <Fallback />
                ) : (
                    <GLBoundary fallback={<Fallback />}>
                        <div className={`rv-canvas-wrap${ready ? " is-ready" : ""}`}>
                            <Canvas
                                frameloop={frameloop}
                                shadows={false}
                                dpr={[1, 2]}
                                gl={{ antialias: true, alpha: true, powerPreference: "high-performance" }}
                                camera={{ position: [1.15, 0.72, 1.55], fov: 40, near: 0.01, far: 100 }}
                                onCreated={({ gl }) => { gl.toneMapping = THREE.ACESFilmicToneMapping; gl.toneMappingExposure = 1.08; }}
                            >
                                <Scene
                                    exploded={exploded} resetKey={resetKey} autoRotate={effectiveAutoRotate}
                                    reduce={reduce} isMobile={isMobile} controlsRef={controlsRef}
                                    onInteractStart={onInteractStart} onInteractEnd={onInteractEnd}
                                />
                            </Canvas>
                        </div>

                        {!ready && (
                            <div className="rv-loading" aria-live="polite">
                                <span className="rv-spin" />
                                <p>Loading 3D model… <b>{Math.round(progress)}%</b></p>
                            </div>
                        )}

                        <div className={`rv-statelabel${exploded ? " is-exploded" : ""}`}>
                            <span>{exploded ? "Disassembled view — components separated" : "Assembled view"}</span>
                            {isAutoAnimating && <span className="rv-auto-badge">● Animated Tour</span>}
                        </div>

                        {hint && ready && !isVideoActive && (
                            <button type="button" className="rv-hint" onClick={() => setHint(false)}>
                                <MousePointer2 size={13} /> Drag to rotate · Scroll to zoom
                                <X size={13} className="rv-hint__x" />
                            </button>
                        )}

                        <div className="rv-controls">
                            <button
                                type="button"
                                className="rv-btn rv-btn--primary"
                                onClick={handleRewatch}
                                title="Rewatch assembly video"
                            >
                                <RotateCcw size={15} /> Rewatch Assembly
                            </button>
                            <button
                                type="button"
                                className={`rv-btn${isAutoAnimating ? " is-on" : ""}`}
                                onClick={toggleAutoAnimate}
                                aria-pressed={isAutoAnimating}
                                title={isAutoAnimating ? "Pause automated animation" : "Play cinematic assembly / disassembly animation"}
                            >
                                {isAutoAnimating ? <Pause size={15} /> : <Play size={15} />}
                                {isAutoAnimating ? "Pause Animation" : "Animate"}
                            </button>
                            <button type="button" className="rv-btn" onClick={() => { setIsAutoAnimating(false); setExploded((v) => !v); }}>
                                {exploded ? <BoxIcon size={16} /> : <Boxes size={16} />}
                                {exploded ? "Reassemble" : "Disassemble"}
                            </button>
                            <button type="button" className="rv-btn" onClick={resetView}>
                                <RotateCcw size={15} /> Reset view
                            </button>
                            <button
                                type="button"
                                className={`rv-btn${autoRotateOn ? " is-on" : ""}`}
                                onClick={() => setAutoRotateOn((v) => !v)}
                                aria-pressed={autoRotateOn}
                            >
                                <RefreshCw size={15} /> Auto-rotate
                            </button>
                        </div>
                    </GLBoundary>
                )}
            </div>

            <p className="rv-caption">
                {isVideoActive
                    ? "VSTY Submersible Micro Robot — Assembly Video"
                    : "Interactive 3D model of our hardware. Drag to orbit, scroll to zoom."}
            </p>
        </div>
    );
}
