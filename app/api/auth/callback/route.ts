import { NextRequest, NextResponse } from "next/server";
import { handleOAuthCallback } from "@/app/lib/mcp-auth";
import { cookies } from "next/headers";

/**
 * After Sentry redirects back with a code we exchange it for tokens,
 * then return a small HTML page that posts a message to the opener
 * window and closes the popup.
 */
export async function GET(request: NextRequest) {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("mcp_session")?.value;
  const code = request.nextUrl.searchParams.get("code");

  let success = false;

  if (sessionId && code) {
    try {
      const appUrl =
        process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
      const callbackUrl = `${appUrl}/api/auth/callback`;
      await handleOAuthCallback(sessionId, code, callbackUrl);
      success = true;
    } catch (error) {
      console.error("OAuth callback error:", error);
    }
  }

  // Return an HTML page that communicates with the opener and self-closes
  const html = `<!DOCTYPE html>
<html><head><title>Connecting...</title></head>
<body style="background:#0a0a0a;color:#e0e0e0;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
<p>${success ? "Connected! This window will close..." : "Connection failed. You can close this window."}</p>
<script>
  if (window.opener) {
    window.opener.postMessage({ type: "sentry-oauth-result", success: ${success} }, "*");
  }
  if (${success}) { setTimeout(() => window.close(), 600); }
</script>
</body></html>`;

  return new NextResponse(html, {
    headers: { "Content-Type": "text/html" },
  });
}
