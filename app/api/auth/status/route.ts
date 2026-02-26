import { NextResponse } from "next/server";
import { decryptSession, COOKIE_NAME } from "@/app/lib/mcp-auth";
import { cookies } from "next/headers";

export async function GET() {
  try {
    const cookieStore = await cookies();
    const encrypted = cookieStore.get(COOKIE_NAME)?.value;

    if (!encrypted) {
      return NextResponse.json({ connected: false });
    }

    const session = await decryptSession(encrypted);
    const connected = !!session?.tokens?.access_token;

    return NextResponse.json({ connected });
  } catch {
    return NextResponse.json({ connected: false });
  }
}
