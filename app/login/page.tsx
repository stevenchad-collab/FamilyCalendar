"use client";
import { useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";

export default function Login() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const sending = useRef(false);

  async function send() {
    if (!email || sending.current) return;   // guard: one send at a time
    sending.current = true;
    setBusy(true);
    setErr("");
    try {
      const supabase = createClient();
      const site = process.env.NEXT_PUBLIC_SITE_URL || window.location.origin;
      const { error } = await supabase.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: `${site}/auth/callback` },
      });
      if (error) setErr(error.message);
      else setSent(true);
    } finally {
      sending.current = false;
      setBusy(false);
    }
  }

  return (
    <main style={{ maxWidth: 420, margin: "16vh auto", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <h1 style={{ fontSize: 30, fontWeight: 800 }}>Family Calendar</h1>
      <p style={{ color: "#6b8595", margin: "8px 0 20px" }}>Sign in with a magic link.</p>
      {sent ? (
        <p style={{ fontSize: 16 }}>✅ Check your email for a sign-in link.</p>
      ) : (
        <div>
          <input
            type="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") send(); }}
            style={{ width: "100%", padding: 12, border: "1px solid #cdd6db", borderRadius: 10, fontSize: 15, boxSizing: "border-box" }}
          />
          <button
            onClick={send}
            disabled={busy || !email}
            style={{ marginTop: 12, width: "100%", padding: "12px 16px", background: "#2c7a7b", color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: "pointer", opacity: busy ? 0.7 : 1 }}
          >
            {busy ? "Sending…" : "Send magic link"}
          </button>
          {err && <p style={{ color: "#c0392b", marginTop: 10 }}>{err}</p>}
        </div>
      )}
    </main>
  );
}
