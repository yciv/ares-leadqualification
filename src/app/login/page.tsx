"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { createSupabaseBrowserClient } from "@/lib/supabase/browser";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(true);

  const next = searchParams.get("next") || "/";
  const error = searchParams.get("error");

  // Redirect if already authenticated
  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user) router.replace(next);
      else setChecking(false);
    });
  }, [next, router]);

  async function handleGoogleSignIn() {
    setLoading(true);
    const supabase = createSupabaseBrowserClient();
    await supabase.auth.signInWithOAuth({
      provider: "google",
      options: {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
      },
    });
    // signInWithOAuth redirects the browser — no need to setLoading(false)
  }

  if (checking) return null;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Playfair+Display:wght@400;700&family=DM+Sans:wght@400;600&display=swap');
      `}</style>

      <div
        style={{
          minHeight: "100vh",
          backgroundColor: "#141414",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontFamily: "'DM Sans', sans-serif",
        }}
      >
        <div
          style={{
            backgroundColor: "#080808",
            border: "1px solid #1e1e1e",
            borderRadius: "12px",
            padding: "48px 40px",
            width: "100%",
            maxWidth: "380px",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {/* Logo */}
          <div
            style={{
              fontFamily: "'Playfair Display', serif",
              fontSize: "28px",
              fontWeight: 700,
              color: "#e8e4de",
              letterSpacing: "0.05em",
              marginBottom: "4px",
            }}
          >
            ARES<span style={{ color: "#c8a24e" }}>.</span>
          </div>

          {/* Tagline */}
          <p
            style={{
              color: "#8a8580",
              fontSize: "13px",
              margin: "0 0 32px 0",
              letterSpacing: "0.04em",
            }}
          >
            Lead Qualification Engine
          </p>

          {/* Google Sign-In Button */}
          <button
            onClick={handleGoogleSignIn}
            disabled={loading}
            style={{
              width: "100%",
              backgroundColor: loading ? "#a07e38" : "#c8a24e",
              color: "#080808",
              border: "none",
              borderRadius: "6px",
              padding: "12px 24px",
              fontSize: "13px",
              fontWeight: 600,
              fontFamily: "'DM Sans', sans-serif",
              letterSpacing: "0.08em",
              textTransform: "uppercase",
              cursor: loading ? "not-allowed" : "pointer",
              transition: "background-color 0.15s ease",
            }}
            onMouseEnter={(e) => {
              if (!loading) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "#d4ae60";
            }}
            onMouseLeave={(e) => {
              if (!loading) (e.currentTarget as HTMLButtonElement).style.backgroundColor = "#c8a24e";
            }}
          >
            {loading ? "Redirecting…" : "Sign in with Google"}
          </button>

          {/* Error messages */}
          {error === "not_authorized" && (
            <p
              style={{
                color: "#8a8580",
                fontSize: "12px",
                textAlign: "center",
                marginTop: "16px",
                lineHeight: "1.5",
              }}
            >
              Your email is not authorized for the beta.{" "}
              <br />
              Contact{" "}
              <a
                href="mailto:contact@aresgtm.com"
                style={{ color: "#c8a24e", textDecoration: "none" }}
              >
                contact@aresgtm.com
              </a>{" "}
              for access.
            </p>
          )}

          {error === "auth_failed" && (
            <p
              style={{
                color: "#8a8580",
                fontSize: "12px",
                textAlign: "center",
                marginTop: "16px",
              }}
            >
              Authentication failed. Please try again.
            </p>
          )}
        </div>
      </div>
    </>
  );
}
