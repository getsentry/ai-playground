import { NextRequest, NextResponse } from "next/server";
import {
  handleOAuthCallback,
  getAppUrl,
  decryptSession,
  encryptSession,
  COOKIE_NAME,
} from "@/app/lib/mcp-auth";
import { cookies } from "next/headers";

/**
 * After Sentry redirects back with a code we exchange it for tokens,
 * then return a small HTML page that posts a message to the opener
 * window and closes the popup.
 */
export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const encrypted = cookieStore.get(COOKIE_NAME)?.value;
  const code = request.nextUrl.searchParams.get("code");

  let success = false;

  if (encrypted && code) {
    try {
      const session = await decryptSession(encrypted);
      if (!session) throw new Error("Failed to decrypt session");

      const callbackUrl = `${getAppUrl()}/api/auth/callback`;
      const updatedSession = await handleOAuthCallback(
        session,
        code,
        callbackUrl
      );

      // Persist the updated session (now with tokens) back to the cookie
      const newEncrypted = await encryptSession(updatedSession);
      cookieStore.set(COOKIE_NAME, newEncrypted, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24, // 24 hours
        path: "/",
      });

      success = true;
    } catch (error) {
      console.error("OAuth callback error:", error);
    }
  }

  // Return an HTML page that communicates with the opener and self-closes.
  // We try multiple strategies to notify the parent window since
  // cross-origin redirects (our app → Sentry → our callback) can
  // clear window.opener in some browsers.
  const appUrl = getAppUrl();
  const html = `<!DOCTYPE html>
<html><head><title>Connecting...</title></head>
<body style="background:#0a0a0a;color:#e0e0e0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p id="status">${success ? "Connected! Returning to app..." : "Connection failed. You can close this window."}</p>
<script>
(function() {
  var success = ${success};
  var isPopup = !!window.opener && !window.opener.closed;

  // Strategy 1: postMessage to opener (works if opener survived redirects)
  if (isPopup) {
    try {
      window.opener.postMessage({ type: "sentry-oauth-result", success: success }, "${appUrl}");
    } catch(e) {}
  }

  // Strategy 2: Use BroadcastChannel (same-origin, works even without opener)
  try {
    var bc = new BroadcastChannel("sentry-oauth");
    bc.postMessage({ type: "sentry-oauth-result", success: success });
    setTimeout(function() { bc.close(); }, 1000);
  } catch(e) {}

  if (success) {
    // Try to close the window (works for desktop popups).
    // If still open after a short delay, redirect back to the app (mobile / full tab).
    setTimeout(function() {
      window.close();
      setTimeout(function() { window.location.href = "${appUrl}"; }, 500);
    }, 800);
  }
})();
</script>
</body></html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html" },
  });
}
