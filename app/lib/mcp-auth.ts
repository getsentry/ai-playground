/**
 * Server-side MCP OAuth helper.
 *
 * The Sentry MCP server speaks the standard MCP OAuth flow:
 *   1. Client discovers the authorization server metadata (RFC 8414).
 *   2. Client does dynamic client registration (RFC 7591).
 *   3. Client redirects the user to the authorization endpoint.
 *   4. After consent the user is redirected back with an auth code.
 *   5. Client exchanges the code for tokens.
 *
 * Session data (OAuth state + tokens) is stored in encrypted,
 * httpOnly cookies so it survives across serverless invocations.
 */

import {
  discoverOAuthMetadata,
  startAuthorization,
  exchangeAuthorization,
  registerClient,
} from "@modelcontextprotocol/sdk/client/auth.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthTokens {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface ClientRegistration {
  client_id: string;
  client_secret?: string;
  redirect_uris: string[];
}

export interface SessionData {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  serverUrl: string;
  clientRegistration?: ClientRegistration;
}

// ---------------------------------------------------------------------------
// App URL helper
// ---------------------------------------------------------------------------

/**
 * Resolve the canonical app URL.
 * Priority: NEXT_PUBLIC_APP_URL > VERCEL_PROJECT_PRODUCTION_URL > localhost
 *
 * Handles values with or without a protocol prefix, e.g.
 *   "https://ai-playground.sentry.dev"  → used as-is
 *   "ai-playground.sentry.dev"          → prefixed with https://
 */
export function getAppUrl(): string {
  const raw = process.env.NEXT_PUBLIC_APP_URL;
  if (raw) {
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      return raw.replace(/\/+$/, "");
    }
    return `https://${raw.replace(/\/+$/, "")}`;
  }
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  return "http://localhost:3000";
}

// ---------------------------------------------------------------------------
// Encrypted cookie helpers (AES-256-GCM via Web Crypto)
// ---------------------------------------------------------------------------

const COOKIE_NAME = "mcp_session_data";

/**
 * Get the encryption key. Uses SESSION_SECRET env var (32+ chars recommended).
 * Falls back to a deterministic key derived from a default for local dev.
 */
async function getEncryptionKey(): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET || "dev-secret-change-me-in-production-32ch";
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret.slice(0, 32).padEnd(32, "0")),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"]
  );
  return keyMaterial;
}

export async function encryptSession(data: SessionData): Promise<string> {
  const key = await getEncryptionKey();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(data));

  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    plaintext
  );

  // Combine iv + ciphertext, base64-encode
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(ciphertext), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decryptSession(
  encrypted: string
): Promise<SessionData | null> {
  try {
    const key = await getEncryptionKey();
    const combined = Uint8Array.from(atob(encrypted), (c) => c.charCodeAt(0));
    const iv = combined.slice(0, 12);
    const ciphertext = combined.slice(12);

    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );

    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
}

export { COOKIE_NAME };

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

const SENTRY_MCP_URL =
  process.env.SENTRY_MCP_URL || "https://mcp.sentry.dev/mcp";

/**
 * Kick off the OAuth authorization flow.
 * Returns { authorizationUrl, session } — the caller must persist
 * `session` into an encrypted cookie.
 */
export async function beginOAuthFlow(
  callbackUrl: string
): Promise<{ authorizationUrl: string; session: SessionData }> {
  const serverUrl = new URL(SENTRY_MCP_URL);

  // 1. Discover OAuth metadata from the MCP server
  const metadata = await discoverOAuthMetadata(serverUrl);
  if (!metadata) {
    throw new Error(
      "Failed to discover OAuth metadata from Sentry MCP server"
    );
  }

  // 2. Dynamic client registration
  const fullRegistration = await registerClient(serverUrl, {
    clientMetadata: {
      redirect_uris: [callbackUrl],
      client_name: "Sentry AI Playground",
      token_endpoint_auth_method: "none",
    },
    metadata,
  });

  const clientRegistration: ClientRegistration = {
    client_id: fullRegistration.client_id,
    client_secret: fullRegistration.client_secret,
    redirect_uris: [callbackUrl],
  };

  // 3. Start authorization (generates PKCE code verifier/challenge)
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    serverUrl,
    {
      metadata,
      clientInformation: fullRegistration,
      redirectUrl: callbackUrl,
    }
  );

  const session: SessionData = {
    serverUrl: SENTRY_MCP_URL,
    codeVerifier,
    clientRegistration,
  };

  return { authorizationUrl: authorizationUrl.toString(), session };
}

/**
 * Handle the OAuth callback – exchange the authorization code for tokens.
 * Returns the updated session with tokens populated.
 */
export async function handleOAuthCallback(
  session: SessionData,
  code: string,
  callbackUrl: string
): Promise<SessionData> {
  if (!session.codeVerifier || !session.clientRegistration) {
    throw new Error("Invalid session – start the OAuth flow again");
  }

  const serverUrl = new URL(session.serverUrl);
  const metadata = await discoverOAuthMetadata(serverUrl);
  if (!metadata) {
    throw new Error("Failed to discover OAuth metadata");
  }

  const tokens = await exchangeAuthorization(serverUrl, {
    metadata,
    clientInformation: {
      ...session.clientRegistration,
      redirect_uris: session.clientRegistration.redirect_uris,
      client_name: "Sentry AI Playground",
      token_endpoint_auth_method: "none",
    },
    authorizationCode: code,
    codeVerifier: session.codeVerifier,
    redirectUri: callbackUrl,
  });

  return {
    ...session,
    tokens: tokens as OAuthTokens,
    codeVerifier: undefined, // consumed
  };
}
