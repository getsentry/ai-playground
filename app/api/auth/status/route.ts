import { NextResponse } from "next/server";
import { getSession } from "@/app/lib/mcp-auth";
import { cookies } from "next/headers";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const sessionId = cookieStore.get("mcp_session")?.value;

    if (!sessionId) {
      return NextResponse.json({ connected: false });
    }

    const session = getSession(sessionId);
    const connected = !!session?.tokens?.access_token;

    return NextResponse.json({ connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
