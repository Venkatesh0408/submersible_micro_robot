/// <reference types="vite/client" />
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

// Client-side Supabase client. Reads the public anon key (safe to expose).
// Preference order:
//   1. Build-time VITE_SUPABASE_* (fastest — inlined by Vite when present).
//   2. Runtime /api/config from our backend (works even if the host's env vars are
//      named without the VITE_ prefix, so no rebuild/rename is needed on the deploy).
// Until one of those resolves, the client is null so the app still runs (guest works).

const AUTH_OPTS = {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
} as const;

const buildUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const buildKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

// Track the resolved URL/key (from build-time or runtime config) for settings lookups.
let activeUrl = buildUrl || "";
let activeKey = buildKey || "";

// `let` exports are live bindings — importers see these update once runtime config resolves.
export let supabase: SupabaseClient | null =
    buildUrl && buildKey ? createClient(buildUrl, buildKey, AUTH_OPTS) : null;
export let isSupabaseConfigured = Boolean(supabase);

// Which auth providers the project actually has enabled — so the UI can hide ones that aren't,
// instead of showing a button that errors. Returns null if it can't be determined (then show all).
export async function getEnabledProviders(): Promise<
    { google: boolean; github: boolean; azure: boolean; phone: boolean; email: boolean } | null
> {
    await supabaseReady;
    if (!activeUrl || !activeKey) return null;
    try {
        const r = await fetch(`${activeUrl}/auth/v1/settings`, { headers: { apikey: activeKey } });
        if (!r.ok) return null;
        const s = await r.json();
        return {
            google: !!s?.external?.google,
            github: !!s?.external?.github,
            azure: !!s?.external?.azure,
            phone: !!s?.external?.phone,
            email: !!s?.external?.email,
        };
    } catch {
        return null;
    }
}

// Where OAuth / magic-link providers redirect back to.
export const authRedirectTo = `${window.location.origin}/auth/callback`;

// Resolves the client, fetching public config from the backend if VITE_ vars weren't provided.
// main.jsx awaits this before rendering so the client is ready before the first component mounts.
export const supabaseReady: Promise<SupabaseClient | null> = (async () => {
    if (supabase) return supabase;
    try {
        const res = await fetch("/api/config", { headers: { Accept: "application/json" } });
        if (res.ok) {
            const cfg = await res.json();
            if (cfg?.supabaseUrl && cfg?.supabaseAnonKey) {
                activeUrl = cfg.supabaseUrl;
                activeKey = cfg.supabaseAnonKey;
                supabase = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, AUTH_OPTS);
                isSupabaseConfigured = true;
            }
        }
    } catch {
        /* leave null — guest-only until configured */
    }
    return supabase;
})();
