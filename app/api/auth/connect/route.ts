import { NextResponse } from "next/server";
import { beginOAuthFlow } from "@/app/lib/mcp-auth";
import { cookies } from "next/headers";

export async function GET() {
  try {
    // Generate a session id
    const sessionId = crypto.randomUUID();
    const appUrl =
      process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000";
    const callbackUrl = `${appUrl}/api/auth/callback`;

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
    return NextResponse.json(
      { error: "Failed to start OAuth flow" },
      { status: 500 }
    );
  }
}
