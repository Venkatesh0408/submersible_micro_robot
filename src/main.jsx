import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "leaflet/dist/leaflet.css";

import "./index.css";
import "./App.css";

import App from "./App.jsx";

import { MissionProvider } from "./context/MissionContext";
import { AuthProvider } from "./context/AuthContext";
import { supabaseReady } from "./lib/supabase";

const mount = () =>
    createRoot(document.getElementById("root")).render(
        <StrictMode>
            <AuthProvider>
                <MissionProvider>
                    <App />
                </MissionProvider>
            </AuthProvider>
        </StrictMode>
    );

// Resolve Supabase config (build-time or runtime /api/config) before first render so
// sign-in is ready immediately. Never block the app if it fails — guest still works.
supabaseReady.finally(mount);