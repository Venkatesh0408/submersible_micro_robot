import { useEffect } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft, Box } from "lucide-react";
import TopNav from "../components/TopNav";
import RobotViewer from "../components/RobotViewer";
import "../styles/ModelViewerPage.css";

const TITLE = "View 3D Model — VSTY Submersible Micro Robot";
const DESC = "Interactive 3D model of the VSTY Submersible Micro Robot — inspect assembled and exploded hardware views with cinematic animation.";

export default function ModelViewerPage() {
    useEffect(() => {
        const prevTitle = document.title;
        document.title = TITLE;
        let meta = document.querySelector('meta[name="description"]');
        const created = !meta;
        if (!meta) {
            meta = document.createElement("meta");
            meta.name = "description";
            document.head.appendChild(meta);
        }
        const prevDesc = meta.getAttribute("content");
        meta.setAttribute("content", DESC);
        return () => {
            document.title = prevTitle;
            if (created) meta.remove();
            else if (prevDesc != null) meta.setAttribute("content", prevDesc);
        };
    }, []);

    return (
        <div className="mvp">
            <TopNav />
            <div className="mvp-bar">
                <Link to="/dashboard" className="mvp-back">
                    <ArrowLeft size={16} /> Back to Dashboard
                </Link>
                <div className="mvp-heading">
                    <span className="mvp-kicker">Hardware Visualization</span>
                    <h1 className="mvp-title">VSTY Submersible Micro Robot — 3D Model</h1>
                </div>
                <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: "8px" }}>
                    <span style={{
                        fontSize: "12px",
                        color: "var(--primary, #00e5ff)",
                        background: "rgba(0, 229, 255, 0.1)",
                        border: "1px solid rgba(0, 229, 255, 0.25)",
                        padding: "5px 12px",
                        borderRadius: "8px",
                        fontWeight: "600",
                        display: "inline-flex",
                        alignItems: "center",
                        gap: "6px"
                    }}>
                        <Box size={14} /> Interactive Hardware Mesh
                    </span>
                </div>
            </div>

            <div className="mvp-viewer">
                <RobotViewer />
            </div>
        </div>
    );
}
