import { useState, useEffect } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import { useNavigate } from 'react-router-dom';
import { User, Lock, ArrowRight, ArrowLeft, UserCheck, Eye, EyeOff, ShieldCheck, Phone, Mail, Loader2, Activity, Database, Cpu, AlertTriangle, Github } from 'lucide-react';
import { toast } from '../components/Toast';
import { supabase, authRedirectTo, isSupabaseConfigured, getEnabledProviders } from '../lib/supabase';
import { useAuth } from '../context/AuthContext';
import '../styles/Login.css';

// --- brand marks (lucide has no brand logos) ---
const GoogleIcon = () => (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
        <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.7-6.1 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.3-.4-3.5z"/>
        <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.9 1.2 8 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
        <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.5 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-7.9l-6.5 5C9.6 39.6 16.2 44 24 44z"/>
        <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.3-2.3 4.2-4.1 5.6l6.2 5.2C41.4 36.2 44 30.6 44 24c0-1.3-.1-2.3-.4-3.5z"/>
    </svg>
);
const MicrosoftIcon = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden>
        <rect x="1" y="1" width="10" height="10" fill="#F25022"/>
        <rect x="13" y="1" width="10" height="10" fill="#7FBA00"/>
        <rect x="1" y="13" width="10" height="10" fill="#00A4EF"/>
        <rect x="13" y="13" width="10" height="10" fill="#FFB900"/>
    </svg>
);

export default function Login() {
    const navigate = useNavigate();
    const reduce = useReducedMotion();
    const { enterAsGuest } = useAuth();

    const [username, setUsername] = useState('');
    const [password, setPassword] = useState('');
    const [showPassword, setShowPassword] = useState(false);
    const [error, setError] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const [busy, setBusy] = useState(null); // 'google' | 'microsoft' | 'phone' | 'magic'
    const [view, setView] = useState('default'); // 'default' | 'phone' | 'email'
    const [phone, setPhone] = useState('');
    const [otp, setOtp] = useState('');
    const [otpSent, setOtpSent] = useState(false);
    const [email, setEmail] = useState('');
    const [emailOtp, setEmailOtp] = useState('');
    const [emailOtpSent, setEmailOtpSent] = useState(false);
    // null until known → show all; once known, hide providers the project hasn't enabled.
    const [providers, setProviders] = useState(null);
    useEffect(() => { let ok = true; getEnabledProviders().then((p) => ok && p && setProviders(p)); return () => { ok = false; }; }, []);
    const showProvider = (k) => !providers || providers[k];

    const needsSupabase = () => {
        if (!supabase) {
            toast.error('Sign-in provider not configured yet. Add your Supabase keys to enable it.', { title: 'Not configured' });
            return false;
        }
        return true;
    };

    // --- OAuth: Google / Microsoft ---
    const oauth = async (provider, key) => {
        if (!needsSupabase()) return;
        setBusy(key);
        try {
            const { error: err } = await supabase.auth.signInWithOAuth({
                provider,
                options: { redirectTo: authRedirectTo, scopes: provider === 'azure' ? 'email openid profile' : undefined },
            });
            if (err) throw err;
            // Browser redirects to the provider; nothing else to do here.
        } catch (err) {
            console.error(`${provider} sign-in error`, err);
            const notEnabled = /provider is not enabled|unsupported provider/i.test(err?.message || '');
            const label = { google: 'Google', github: 'GitHub', microsoft: 'Microsoft' }[key] || key;
            toast.error(
                notEnabled
                    ? `${label} sign-in isn’t enabled yet — enable it in Supabase → Authentication → Providers.`
                    : (err.message || `Could not start ${label} sign-in.`),
                { title: 'Sign-in failed' }
            );
            setBusy(null);
        }
    };
    const signInWithGoogle = () => oauth('google', 'google');
    const signInWithMicrosoft = () => oauth('azure', 'microsoft');
    const signInWithGithub = () => oauth('github', 'github');

    // --- Phone SMS OTP ---
    const sendPhoneOtp = async () => {
        if (!needsSupabase()) return;
        if (!phone.trim()) { toast.warning('Enter your phone number in international format (e.g. +14155551234).'); return; }
        setBusy('phone');
        try {
            const { error: err } = await supabase.auth.signInWithOtp({ phone: phone.trim() });
            if (err) throw err;
            setOtpSent(true);
            toast.success('Verification code sent by SMS.', { title: 'Code sent' });
        } catch (err) {
            console.error('phone OTP error', err);
            const noProvider = /unsupported phone provider|provider is not enabled/i.test(err?.message || '');
            toast.error(
                noProvider
                    ? 'Phone sign-in needs an SMS provider (Twilio/MessageBird) set up in Supabase. Use email instead.'
                    : (err.message || 'Could not send the SMS code.'),
                { title: 'Sign-in failed' }
            );
        } finally {
            setBusy(null);
        }
    };
    const verifyPhoneOtp = async () => {
        if (!needsSupabase()) return;
        if (!otp.trim()) { toast.warning('Enter the 6-digit code you received.'); return; }
        setBusy('phone');
        try {
            const { error: err } = await supabase.auth.verifyOtp({ phone: phone.trim(), token: otp.trim(), type: 'sms' });
            if (err) throw err;
            toast.success('Signed in.', { title: 'Welcome' });
            navigate('/dashboard');
        } catch (err) {
            console.error('phone verify error', err);
            toast.error(err.message || 'Invalid or expired code.', { title: 'Verification failed' });
        } finally {
            setBusy(null);
        }
    };

    // --- Email OTP code (register + sign in in one; auto-creates the user on first use) ---
    const sendEmailOtp = async () => {
        if (!needsSupabase()) return;
        const addr = email.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { toast.warning('Enter a valid email address.'); return; }
        setBusy('email');
        try {
            const { error: err } = await supabase.auth.signInWithOtp({
                email: addr,
                options: { shouldCreateUser: true, emailRedirectTo: authRedirectTo },
            });
            if (err) throw err;
            setEmailOtpSent(true);
            toast.success(`We sent a 6-digit code to ${addr}.`, { title: 'Check your inbox' });
        } catch (err) {
            console.error('email OTP error', err);
            const smtp = /sending|smtp|confirmation|email/i.test(err?.message || '');
            toast.error(
                smtp
                    ? 'Could not send the email. Set up SMTP (Resend) in Supabase → Authentication → SMTP, with a verified sender domain.'
                    : (err.message || 'Could not send the email code.'),
                { title: 'Sign-in failed' }
            );
        } finally {
            setBusy(null);
        }
    };
    const verifyEmailOtp = async () => {
        if (!needsSupabase()) return;
        if (!emailOtp.trim()) { toast.warning('Enter the 6-digit code from your email.'); return; }
        setBusy('email');
        try {
            const { error: err } = await supabase.auth.verifyOtp({ email: email.trim(), token: emailOtp.trim(), type: 'email' });
            if (err) throw err;
            toast.success('Signed in.', { title: 'Welcome' });
            navigate('/dashboard');
        } catch (err) {
            console.error('email verify error', err);
            toast.error(err.message || 'Invalid or expired code.', { title: 'Verification failed' });
        } finally {
            setBusy(null);
        }
    };

    // --- Email magic-link (fallback for people who prefer a link over a code) ---
    const sendMagicLink = async () => {
        if (!needsSupabase()) return;
        const addr = (email.trim() || username.trim());
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) {
            toast.warning('Enter your email address first.');
            return;
        }
        setBusy('magic');
        try {
            const { error: err } = await supabase.auth.signInWithOtp({ email: addr, options: { shouldCreateUser: true, emailRedirectTo: authRedirectTo } });
            if (err) throw err;
            toast.success(`Magic sign-in link sent to ${addr}.`, { title: 'Check your inbox' });
        } catch (err) {
            console.error('magic link error', err);
            toast.error(err.message || 'Could not send the magic link.', { title: 'Sign-in failed' });
        } finally {
            setBusy(null);
        }
    };

    // Guest — no-auth path (kept working regardless of Supabase config)
    const handleGuest = () => {
        enterAsGuest();
        navigate('/dashboard');
    };

    // --- existing email/password auth (backend unchanged) ---
    const handlePasswordLogin = async (e) => {
        e.preventDefault();
        setError('');
        setIsLoading(true);
        try {
            const response = await fetch(window.location.origin + '/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            if (!response.ok) { setError(`Server returned error (${response.status})`); return; }
            const contentType = response.headers.get("content-type") || "";
            if (!contentType.includes("application/json")) { setError('Invalid server response format'); return; }
            const text = await response.text();
            if (!text || text.trim().startsWith("<")) { setError('Received HTML instead of JSON'); return; }
            const data = JSON.parse(text);
            if (data.success) {
                localStorage.setItem('token', data.token);
                localStorage.setItem('user', JSON.stringify(data.user));
                navigate('/dashboard');
            } else {
                setError(data.message || 'Login failed');
            }
        } catch (err) {
            console.error('Login error', err);
            setError('An error occurred during login');
        } finally {
            setIsLoading(false);
        }
    };

    const Spinner = () => <Loader2 size={16} className="signin-spin" />;

    return (
        <div className="signin-page">
            <button type="button" className="signin-back" onClick={() => (view !== 'default' ? setView('default') : navigate('/home'))}>
                <ArrowLeft size={16} /> Back
            </button>

            <div className="signin-shell">
                <motion.div
                    className="signin-card"
                    initial={reduce ? false : { opacity: 0, y: 22 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: 'easeOut' }}
                >
                    <div className="signin-head">
                        <span className="signin-badge"><ShieldCheck size={26} /></span>
                        <h2>Welcome Back</h2>
                        <p>{view === 'phone' ? 'Sign in with your phone number' : view === 'email' ? 'Sign in or register with an email code' : 'Sign in to access Mission Control'}</p>
                    </div>

                    {!isSupabaseConfigured && (
                        <div style={{ display: 'flex', gap: '10px', alignItems: 'flex-start', background: 'rgba(255,183,3,0.10)', border: '1px solid rgba(255,183,3,0.35)', borderRadius: '10px', padding: '11px 13px', marginBottom: '4px' }}>
                            <AlertTriangle size={16} style={{ color: 'var(--warning)', flexShrink: 0, marginTop: '2px' }} />
                            <div style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--text-dim)' }}>
                                <strong style={{ color: 'var(--text)' }}>Sign-in isn’t configured yet.</strong> Set <code>VITE_SUPABASE_URL</code> and <code>VITE_SUPABASE_ANON_KEY</code> in the environment, then redeploy. You can still explore everything with <em>Continue as Guest</em> below.
                            </div>
                        </div>
                    )}

                    {view === 'phone' ? (
                        /* ---------- Phone OTP flow ---------- */
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <div className="signin-field">
                                <span className="signin-field__icon"><Phone size={18} /></span>
                                <input
                                    className="signin-input"
                                    type="tel"
                                    placeholder="Phone (e.g. +14155551234)"
                                    value={phone}
                                    onChange={(e) => setPhone(e.target.value)}
                                    autoComplete="tel"
                                    disabled={otpSent}
                                />
                            </div>
                            {otpSent && (
                                <div className="signin-field">
                                    <span className="signin-field__icon"><Lock size={18} /></span>
                                    <input
                                        className="signin-input"
                                        type="text"
                                        inputMode="numeric"
                                        placeholder="6-digit code"
                                        value={otp}
                                        onChange={(e) => setOtp(e.target.value)}
                                        autoComplete="one-time-code"
                                    />
                                </div>
                            )}
                            <button type="button" className="signin-primary" onClick={otpSent ? verifyPhoneOtp : sendPhoneOtp} disabled={busy === 'phone'}>
                                {busy === 'phone' ? <Spinner /> : null}
                                {otpSent ? 'Verify & Sign In' : 'Send Code'}
                            </button>
                            {otpSent && (
                                <button type="button" className="signin-forgot" style={{ alignSelf: 'center' }} onClick={() => { setOtpSent(false); setOtp(''); }}>
                                    Use a different number
                                </button>
                            )}
                        </div>
                    ) : view === 'email' ? (
                        /* ---------- Email OTP code flow (register + sign in) ---------- */
                        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                            <div className="signin-field">
                                <span className="signin-field__icon"><Mail size={18} /></span>
                                <input className="signin-input" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" disabled={emailOtpSent} />
                            </div>
                            {emailOtpSent && (
                                <div className="signin-field">
                                    <span className="signin-field__icon"><Lock size={18} /></span>
                                    <input className="signin-input" type="text" inputMode="numeric" placeholder="6-digit code" value={emailOtp} onChange={(e) => setEmailOtp(e.target.value)} autoComplete="one-time-code" />
                                </div>
                            )}
                            <button type="button" className="signin-primary" onClick={emailOtpSent ? verifyEmailOtp : sendEmailOtp} disabled={busy === 'email'}>
                                {busy === 'email' ? <Spinner /> : null}
                                {emailOtpSent ? 'Verify & Sign In' : 'Send Code'}
                            </button>
                            {emailOtpSent ? (
                                <button type="button" className="signin-forgot" style={{ alignSelf: 'center' }} onClick={() => { setEmailOtpSent(false); setEmailOtp(''); }}>
                                    Use a different email
                                </button>
                            ) : (
                                <button type="button" className="signin-forgot" style={{ alignSelf: 'center' }} onClick={sendMagicLink} disabled={busy === 'magic'}>
                                    {busy === 'magic' ? <Spinner /> : null} Prefer a link? Email me a magic link
                                </button>
                            )}
                        </div>
                    ) : (
                        /* ---------- Default: social + email/password ---------- */
                        <>
                            <div className="signin-social">
                                {showProvider('google') && (
                                    <button type="button" className="signin-social__btn" onClick={signInWithGoogle} disabled={busy === 'google'} aria-label="Sign in with Google">
                                        {busy === 'google' ? <Spinner /> : <GoogleIcon />} Google
                                    </button>
                                )}
                                {showProvider('github') && (
                                    <button type="button" className="signin-social__btn" onClick={signInWithGithub} disabled={busy === 'github'} aria-label="Sign in with GitHub">
                                        {busy === 'github' ? <Spinner /> : <Github size={16} />} GitHub
                                    </button>
                                )}
                                {showProvider('azure') && (
                                    <button type="button" className="signin-social__btn" onClick={signInWithMicrosoft} disabled={busy === 'microsoft'} aria-label="Sign in with Microsoft">
                                        {busy === 'microsoft' ? <Spinner /> : <MicrosoftIcon />} Outlook
                                    </button>
                                )}
                                {showProvider('phone') && (
                                    <button type="button" className="signin-social__btn" onClick={() => setView('phone')} aria-label="Sign in with phone">
                                        <Phone size={16} /> Phone
                                    </button>
                                )}
                            </div>

                            <div className="signin-divider"><span>or continue with email</span></div>

                            {error && (
                                <motion.div className="signin-error" initial={reduce ? false : { opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
                                    {error}
                                </motion.div>
                            )}

                            <form className="signin-form" onSubmit={handlePasswordLogin} style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                                <div className="signin-field">
                                    <span className="signin-field__icon"><User size={18} /></span>
                                    <input id="username-input" className="signin-input" type="text" placeholder="Username or email"
                                        value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required />
                                </div>

                                <div className="signin-field">
                                    <span className="signin-field__icon"><Lock size={18} /></span>
                                    <input id="password-input" className="signin-input signin-input--pw" type={showPassword ? 'text' : 'password'} placeholder="Password"
                                        value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                                    <button type="button" className="signin-pw-toggle" onClick={() => setShowPassword((s) => !s)} aria-label={showPassword ? 'Hide password' : 'Show password'}>
                                        {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                                    </button>
                                </div>

                                <div className="signin-options">
                                    <label className="signin-remember"><input type="checkbox" /> Remember me</label>
                                    <button type="button" className="signin-forgot">Forgot password?</button>
                                </div>

                                <button type="submit" className="signin-primary" disabled={isLoading}>
                                    {isLoading ? <Spinner /> : null}
                                    {isLoading ? 'Authenticating…' : 'Sign In'} {!isLoading && <ArrowRight size={18} />}
                                </button>
                            </form>

                            <button type="button" className="signin-magic" onClick={() => setView('email')}>
                                <Mail size={16} /> Continue with Email (one-time code)
                            </button>

                            <div className="signin-divider"><span>or</span></div>

                            <button type="button" className="signin-guest" onClick={handleGuest}>
                                <UserCheck size={17} /> Continue as Guest
                            </button>
                            <p className="signin-hint">Sign-in is optional — explore the full dashboard as a guest.</p>
                        </>
                    )}
                </motion.div>

                <div className="signin-status">
                    <span><Activity size={13} style={{ color: '#22c55e' }} /> Status: Online</span>
                    <span className="dot">·</span>
                    <span><Database size={13} style={{ color: '#22c55e' }} /> Secure</span>
                    <span className="dot">·</span>
                    <span><Cpu size={13} style={{ color: 'var(--primary)' }} /> v2.4.1</span>
                </div>
            </div>
        </div>
    );
}
