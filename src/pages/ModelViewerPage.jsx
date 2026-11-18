import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowLeft } from "lucide-react";
import RobotViewer from "../components/RobotViewer";
import "../styles/ModelViewerPage.css";

const TITLE = "Robot Assembly & 3D Model — VSTY Submersible Micro Robot";
const DESC = "Actual assembly video and interactive 3D model of the VSTY Submersible Micro Robot — inspect assembled and exploded hardware views.";

export default function ModelViewerPage() {
    const [videoActive, setVideoActive] = useState(true);

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
            {!videoActive && (
                <Link to="/dashboard" className="mvp-back mvp-back--float">
                    <ArrowLeft size={16} /> Back to Dashboard
                </Link>
            )}

            <div className="mvp-viewer">
                <RobotViewer onVideoStateChange={setVideoActive} />
            </div>
        </div>
    );
}
