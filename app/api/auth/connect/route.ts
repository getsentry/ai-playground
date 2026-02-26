import { NextResponse } from "next/server";
import {
  beginOAuthFlow,
  getAppUrl,
  encryptSession,
  COOKIE_NAME,
} from "@/app/lib/mcp-auth";
import { cookies } from "next/headers";

export async function GET() {
  try {
    const callbackUrl = `${getAppUrl()}/api/auth/callback`;

    const { authorizationUrl, session } = await beginOAuthFlow(callbackUrl);

    // Store the OAuth state (code verifier, client registration) in an
    // encrypted cookie so it survives across serverless invocations.
    const cookieStore = await cookies();
    const encrypted = await encryptSession(session);
    cookieStore.set(COOKIE_NAME, encrypted, {
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
