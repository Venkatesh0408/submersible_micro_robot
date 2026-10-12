import { createContext, useContext, useEffect, useState } from "react";
import { supabase, isSupabaseConfigured } from "../lib/supabase";

const AuthContext = createContext(null);
export const useAuth = () => useContext(AuthContext);

const TOKEN_KEY = "token";
const USER_KEY = "user";

const readGuest = () => {
    try {
        const t = localStorage.getItem(TOKEN_KEY);
        return typeof t === "string" && t.startsWith("guest-");
    } catch {
        return false;
    }
};

const readStoredBackendUser = () => {
    try {
        const t = localStorage.getItem(TOKEN_KEY);
        if (!t || t.startsWith("guest-")) return null;
        const rawUser = localStorage.getItem(USER_KEY);
        if (!rawUser) return null;
        const parsed = JSON.parse(rawUser);
        return parsed && typeof parsed === "object" && parsed.username ? parsed : null;
    } catch {
        return null;
    }
};

export function AuthProvider({ children }) {
    const [session, setSession] = useState(null);
    const [backendUser, setBackendUser] = useState(readStoredBackendUser);
    const [guest, setGuest] = useState(readGuest);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let active = true;

        const verifyBackendToken = async () => {
            try {
                const token = localStorage.getItem(TOKEN_KEY);
                if (!token || token.startsWith("guest-")) return;
                const res = await fetch("/api/auth/me", {
                    headers: { Authorization: `Bearer ${token}` },
                });
                if (!active) return;
                if (res.ok) {
                    const data = await res.json();
                    if (data?.success && data?.user) {
                        setBackendUser(data.user);
                        localStorage.setItem(USER_KEY, JSON.stringify(data.user));
                        return;
                    }
                }
                if (res.status === 401 || res.status === 403) {
                    localStorage.removeItem(TOKEN_KEY);
                    localStorage.removeItem(USER_KEY);
                    setBackendUser(null);
                }
            } catch {
                // Keep cached backendUser if offline
            }
        };

        verifyBackendToken();

        if (!supabase) {
            setLoading(false);
            return () => {
                active = false;
            };
        }
        supabase.auth.getSession().then(({ data }) => {
            if (!active) return;
            setSession(data.session);
            setLoading(false);
        });
        const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => {
            setSession(s);
            if (s) {
                // A real Supabase session supersedes a guest session.
                if (readGuest()) {
                    localStorage.removeItem(TOKEN_KEY);
                }
                setGuest(false);
            }
        });
        return () => {
            active = false;
            sub.subscription.unsubscribe();
        };
    }, []);

    const completeBackendAuth = (userObj, token) => {
        if (token) {
            localStorage.setItem(TOKEN_KEY, token);
        }
        if (userObj) {
            localStorage.setItem(USER_KEY, JSON.stringify(userObj));
        }
        setBackendUser(userObj || null);
        setGuest(false);
    };

    // No-auth path into the dashboard.
    const enterAsGuest = () => {
        localStorage.setItem(TOKEN_KEY, "guest-" + Date.now());
        localStorage.setItem(USER_KEY, JSON.stringify({ username: "Guest Operator", role: "guest" }));
        setBackendUser(null);
        setGuest(true);
    };

    const signOut = async () => {
        if (supabase) {
            try {
                await supabase.auth.signOut();
            } catch (e) {
                console.warn("signOut error", e);
            }
        }
        try {
            await fetch("/api/auth/logout", { method: "POST" });
        } catch {
            // ignore network error on logout
        }
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USER_KEY);
        setSession(null);
        setBackendUser(null);
        setGuest(false);
    };

    const activeUser = session?.user ?? backendUser ?? (guest ? { username: "Guest Operator", role: "guest" } : null);

    const value = {
        supabase,
        isSupabaseConfigured,
        session,
        user: activeUser,
        backendUser,
        guest,
        isAuthed: Boolean(session) || Boolean(backendUser) || guest,
        loading,
        completeBackendAuth,
        enterAsGuest,
        signOut,
    };

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

