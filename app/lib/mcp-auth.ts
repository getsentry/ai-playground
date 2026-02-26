/**
 * Server-side MCP OAuth helper.
 *
 * The Sentry MCP server (https://mcp.sentry.dev/sse) speaks the standard
 * MCP OAuth flow:
 *   1. Client hits the MCP URL and gets a 401 with OAuth metadata.
 *   2. Client discovers the authorization server metadata (RFC 8414).
 *   3. Client does dynamic client registration (RFC 7591).
 *   4. Client redirects the user to the authorization endpoint.
 *   5. After consent the user is redirected back with an auth code.
 *   6. Client exchanges the code for tokens.
 *
 * We store tokens in an in-memory map keyed by a session id stored in a
 * cookie. This is intentionally simple for a playground app.
 */

import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
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

interface StoredSession {
  tokens?: OAuthTokens;
  codeVerifier?: string;
  serverUrl: string;
  clientRegistration?: ClientRegistration;
}

// ---------------------------------------------------------------------------
// In-memory store  (swap for Redis / DB in production)
// ---------------------------------------------------------------------------

const sessions = new Map<string, StoredSession>();

export function getSession(id: string): StoredSession | undefined {
  return sessions.get(id);
}

export function setSession(id: string, session: StoredSession): void {
  sessions.set(id, session);
}

export function deleteSession(id: string): void {
  sessions.delete(id);
}

// ---------------------------------------------------------------------------
// OAuth helpers
// ---------------------------------------------------------------------------

const SENTRY_MCP_URL = process.env.SENTRY_MCP_URL || "https://mcp.sentry.dev/mcp";

/**
 * Kick off the OAuth authorization flow for a given session.
 * Returns the URL the browser should be redirected to.
 */
export async function beginOAuthFlow(
  sessionId: string,
  callbackUrl: string
): Promise<string> {
  const serverUrl = new URL(SENTRY_MCP_URL);

  // 1. Discover OAuth metadata from the MCP server
  const metadata = await discoverOAuthMetadata(serverUrl);
  if (!metadata) {
    throw new Error("Failed to discover OAuth metadata from Sentry MCP server");
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

  // Persist what we need for the callback
  setSession(sessionId, {
    serverUrl: SENTRY_MCP_URL,
    codeVerifier,
    clientRegistration,
  });

  return authorizationUrl.toString();
}

/**
 * Handle the OAuth callback – exchange the authorization code for tokens.
 */
export async function handleOAuthCallback(
  sessionId: string,
  code: string,
  callbackUrl: string
): Promise<void> {
  const session = getSession(sessionId);
  if (!session || !session.codeVerifier || !session.clientRegistration) {
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

  setSession(sessionId, {
    ...session,
    tokens: tokens as OAuthTokens,
    codeVerifier: undefined, // consumed
  });
}

/**
 * Build an OAuthClientProvider that uses our stored tokens.
 * This is what the AI SDK MCP transport uses to attach the Bearer token.
 */
export function createOAuthProvider(
  sessionId: string
): OAuthClientProvider {
  const session = getSession(sessionId);

  return {
    get redirectUrl() {
      return new URL("/api/auth/callback", process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").toString();
    },

    get clientMetadata() {
      const redirectUri = new URL("/api/auth/callback", process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000").toString();
      return {
        redirect_uris: [redirectUri],
        client_name: "Sentry AI Playground",
        token_endpoint_auth_method: "none" as const,
      };
    },

    async clientInformation() {
      if (session?.clientRegistration) {
        return {
          ...session.clientRegistration,
          client_name: "Sentry AI Playground",
          token_endpoint_auth_method: "none" as const,
        };
      }
      return undefined;
    },

    async tokens() {
      const current = getSession(sessionId);
      if (current?.tokens) {
        return current.tokens;
      }
      return undefined;
    },

    async saveTokens(tokens: OAuthTokens) {
      const current = getSession(sessionId);
      if (current) {
        setSession(sessionId, { ...current, tokens });
      }
    },

    async redirectToAuthorization(authorizationUrl: URL) {
      // Not used server-side – we handle this via our API route
      throw new Error("Server-side redirect not supported");
    },

    async saveCodeVerifier(verifier: string) {
      const current = getSession(sessionId);
      if (current) {
        setSession(sessionId, { ...current, codeVerifier: verifier });
      }
    },

    async codeVerifier() {
      const current = getSession(sessionId);
      return current?.codeVerifier || "";
    },

    async saveClientInformation(info: ClientRegistration) {
      const current = getSession(sessionId);
      if (current) {
        setSession(sessionId, { ...current, clientRegistration: info });
      }
    },
  };
}
