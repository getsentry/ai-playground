import { NextResponse } from "next/server";
import { beginOAuthFlow, getAppUrl } from "@/app/lib/mcp-auth";
import { cookies } from "next/headers";

export async function GET() {
  try {
    // Generate a session id
    const sessionId = crypto.randomUUID();
    const callbackUrl = `${getAppUrl()}/api/auth/callback`;

    const authorizationUrl = await beginOAuthFlow(sessionId, callbackUrl);

    // Set session cookie
    const cookieStore = await cookies();
    cookieStore.set("mcp_session", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 60 * 60 * 24, // 24 hours
      path: "/",
    });

    return NextResponse.redirect(authorizationUrl);
  } catch (error) {
    console.error("OAuth connect error:", error);
    const message =
      error instanceof Error ? error.message : "Unknown error";
    return NextResponse.json(
      { error: "Failed to start OAuth flow", detail: message },
      { status: 500 }
    );
  }
}
