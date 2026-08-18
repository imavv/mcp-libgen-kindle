import { createHash, randomBytes } from "node:crypto";
import { config } from "@/lib/config";
import { signJwt, verifyJwt, JwtError, type Claims } from "./jwt";

/**
 * The authorization-server half of this deployment.
 *
 * This app plays two OAuth roles at once, which is unusual in production but
 * sensible for a single-user server: /api/mcp is the *resource server* (it
 * only validates tokens) and /api/oauth/* is the *authorization server* (it
 * logs the owner in and issues them). Keeping both here means no database
 * and no third-party account — at the cost of the limits documented under
 * "Revocation" below.
 *
 * Nothing is stored. Every artefact the flow produces — client registration,
 * authorization code, access token, refresh token — is a signed JWT that
 * carries its own state. Vercel functions have no disk and no shared memory
 * between invocations, so the alternative would be attaching a database to
 * hold three rows.
 *
 * Revocation: because nothing is stored, individual tokens cannot be
 * revoked. Rotating OAUTH_SIGNING_KEY invalidates every token at once and is
 * the only revocation mechanism here. For one user with one client that is a
 * reasonable trade; for anything multi-tenant it is not.
 */

export const SCOPES = {
  "mcp:read": "Search libgen and list books already in your Drive library",
  "mcp:write": "Download books from libgen into your Google Drive",
  "kindle:send": "Email a stored book to your Kindle address",
} as const;

export type Scope = keyof typeof SCOPES;
export const ALL_SCOPES = Object.keys(SCOPES) as Scope[];

/**
 * Which scope each tool needs. send_to_kindle is separated from the rest
 * deliberately: it is the one irreversible action in the server, so a
 * connection can be granted everything else and still be unable to push
 * anything to the device.
 */
export const TOOL_SCOPES: Record<string, Scope> = {
  search_libgen: "mcp:read",
  list_library: "mcp:read",
  download_book: "mcp:write",
  send_to_kindle: "kindle:send",
};

export const CODE_TTL_SECONDS = 60;
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 60 * 60 * 24 * 30;

export const signingKey = config.oauth.signingKey;
export const ownerPassword = config.oauth.ownerPassword;

/**
 * The public origin of this deployment.
 *
 * Behind Vercel's proxy req.url is not reliably the URL the client typed, so
 * this reads the forwarded headers instead. Issuer and audience values must
 * match byte-for-byte across the metadata documents and the tokens, so all
 * of it funnels through here. OAUTH_ISSUER overrides for the odd case of a
 * custom domain that does not match the forwarded host.
 */
export function origin(req: Request): string {
  const override = config.oauth.issuer();
  if (override) return override;

  const host = req.headers.get("x-forwarded-host") || req.headers.get("host");
  if (!host) return new URL(req.url).origin;
  const proto =
    req.headers.get("x-forwarded-proto") || (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}

/** The canonical resource identifier clients bind their tokens to. */
export function resourceUrl(req: Request): string {
  return `${origin(req)}/api/mcp`;
}

// --- Client registration ----------------------------------------------------

export type RegisteredClient = {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
};

/**
 * Dynamic Client Registration (RFC 7591) without a client table: the
 * client_id *is* the signed registration. Anyone can mint one — that is how
 * DCR works, and it is why registration confers no access on its own. The
 * gate is the consent screen, where a human types a password.
 *
 * Note for later: the 2026-07-28 MCP revision deprecates DCR in favour of
 * Client ID Metadata Documents, with DCR supported for at least another
 * twelve months. DCR is what shipping clients still send, so it is what this
 * implements.
 */
export function registerClient(input: {
  client_name?: string;
  redirect_uris: string[];
}): RegisteredClient {
  const redirect_uris = input.redirect_uris.filter(isAllowedRedirectUri);
  if (redirect_uris.length === 0) {
    throw new Error("redirect_uris must contain at least one https or loopback URI");
  }
  const client_name = (input.client_name || "Unnamed MCP client").slice(0, 120);
  return {
    client_id: signJwt({ typ: "client", client_name, redirect_uris }, signingKey()),
    client_name,
    redirect_uris,
  };
}

export function readClient(clientId: string): RegisteredClient {
  const claims = verifyJwt(clientId, signingKey());
  if (claims.typ !== "client") throw new JwtError("not a client registration");
  return {
    client_id: clientId,
    client_name: String(claims.client_name || "Unnamed MCP client"),
    redirect_uris: (claims.redirect_uris as string[]) || [],
  };
}

/**
 * Redirect URIs must be https, or loopback for a client running on the
 * user's own machine. An open redirect here would let anyone who can reach
 * the consent page have a code delivered to a host of their choosing.
 */
export function isAllowedRedirectUri(uri: string): boolean {
  try {
    const u = new URL(uri);
    if (u.protocol === "https:") return true;
    return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
  } catch {
    return false;
  }
}

/** A client_id is long; this is what goes into tokens to bind them to it. */
export function clientRef(clientId: string): string {
  return createHash("sha256").update(clientId).digest("base64url").slice(0, 16);
}

// --- PKCE -------------------------------------------------------------------

/**
 * S256 only. The "plain" method offers no protection against an intercepted
 * code, and OAuth 2.1 drops it.
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = createHash("sha256").update(verifier).digest("base64url");
  return computed === challenge;
}

// --- Codes and tokens -------------------------------------------------------

export function issueCode(params: {
  clientId: string;
  redirectUri: string;
  scope: string;
  codeChallenge: string;
  resource: string;
  issuer: string;
}): string {
  return signJwt(
    {
      typ: "code",
      iss: params.issuer,
      sub: "owner",
      cid: clientRef(params.clientId),
      redirect_uri: params.redirectUri,
      scope: params.scope,
      code_challenge: params.codeChallenge,
      resource: params.resource,
      jti: randomBytes(8).toString("base64url"),
    },
    signingKey(),
    CODE_TTL_SECONDS
  );
}

export function issueAccessToken(params: {
  clientId: string;
  scope: string;
  issuer: string;
  resource: string;
}): string {
  return signJwt(
    {
      typ: "access",
      iss: params.issuer,
      aud: params.resource,
      sub: "owner",
      cid: clientRef(params.clientId),
      scope: params.scope,
      jti: randomBytes(8).toString("base64url"),
    },
    signingKey(),
    ACCESS_TTL_SECONDS
  );
}

export function issueRefreshToken(params: {
  clientId: string;
  scope: string;
  issuer: string;
  resource: string;
}): string {
  return signJwt(
    {
      typ: "refresh",
      iss: params.issuer,
      aud: params.issuer,
      sub: "owner",
      cid: clientRef(params.clientId),
      scope: params.scope,
      resource: params.resource,
      jti: randomBytes(8).toString("base64url"),
    },
    signingKey(),
    REFRESH_TTL_SECONDS
  );
}

export function readTyped(token: string, typ: string): Claims {
  const claims = verifyJwt(token, signingKey());
  if (claims.typ !== typ) throw new JwtError(`expected a ${typ} token`);
  return claims;
}

/**
 * Intersects a requested scope string with what this server offers.
 *
 * A client that asks for nothing gets everything offered, which is what most
 * MCP clients expect — they have no UI for picking scopes. A client that
 * asks for scopes this server does not have gets an empty list, and the
 * authorize endpoint turns that into invalid_scope rather than silently
 * handing over more than was asked for.
 */
export function normalizeScope(requested: string | null | undefined): Scope[] {
  if (!requested || !requested.trim()) return [...ALL_SCOPES];
  const asked = requested.split(/[\s+]+/).filter(Boolean);
  return ALL_SCOPES.filter((s) => asked.includes(s));
}
