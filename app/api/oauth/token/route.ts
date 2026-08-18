import {
  ACCESS_TTL_SECONDS,
  clientRef,
  issueAccessToken,
  issueRefreshToken,
  origin,
  readTyped,
  resourceUrl,
  verifyPkce,
} from "@/lib/oauth/server";

/**
 * The token endpoint. No browser ever reaches this — it is the client's
 * back-channel call, and the only place where a code or a refresh token
 * turns into something that opens /api/mcp.
 *
 * Both grants end the same way: a fresh access token plus a fresh refresh
 * token. Rotating the refresh token on every use is OAuth 2.1's answer to a
 * stolen one, and it is the only revocation-ish behaviour a stateless server
 * gets — though without stored state the old token stays valid until it
 * expires rather than being invalidated on reuse.
 */
export async function POST(req: Request) {
  const body = await readBody(req);
  const grant = body.get("grant_type");

  try {
    if (grant === "authorization_code") return await authorizationCode(req, body);
    if (grant === "refresh_token") return await refresh(req, body);
    return fail("unsupported_grant_type", `grant_type "${grant}" is not supported`);
  } catch (err) {
    // Anything that throws past here is a signature, expiry, or type failure.
    // The description is deliberately specific: this server has one user, and
    // that user is the one debugging it.
    return fail("invalid_grant", err instanceof Error ? err.message : String(err));
  }
}

async function authorizationCode(req: Request, body: URLSearchParams) {
  const code = body.get("code");
  const verifier = body.get("code_verifier");
  const clientId = body.get("client_id");
  const redirectUri = body.get("redirect_uri");

  if (!code || !verifier || !clientId) {
    return fail("invalid_request", "code, code_verifier and client_id are all required");
  }

  const claims = readTyped(code, "code");

  // Each of these bindings closes off a different attack. The client check
  // stops a code leaked to one client being redeemed by another; the
  // redirect_uri check stops a code obtained through a substituted URI; PKCE
  // stops a code captured in transit being useful without the verifier that
  // never left the client.
  if (claims.cid !== clientRef(clientId)) {
    return fail("invalid_grant", "this code was issued to a different client");
  }
  if (redirectUri && claims.redirect_uri !== redirectUri) {
    return fail("invalid_grant", "redirect_uri does not match the one in the code");
  }
  if (!verifyPkce(verifier, String(claims.code_challenge))) {
    return fail("invalid_grant", "PKCE verifier does not match the challenge");
  }

  return tokens(req, clientId, String(claims.scope || ""));
}

async function refresh(req: Request, body: URLSearchParams) {
  const token = body.get("refresh_token");
  const clientId = body.get("client_id");
  if (!token) return fail("invalid_request", "refresh_token is required");

  const claims = readTyped(token, "refresh");
  if (clientId && claims.cid !== clientRef(clientId)) {
    return fail("invalid_grant", "this refresh token was issued to a different client");
  }

  // A refresh token carries its own client binding, so a client that has
  // forgotten its client_id can still refresh. The scope cannot grow here:
  // whatever was consented to at the consent screen is what comes back.
  return tokens(req, clientId || "", String(claims.scope || ""), claims.cid as string);
}

function tokens(req: Request, clientId: string, scope: string, existingRef?: string) {
  const issuer = origin(req);
  const resource = resourceUrl(req);
  // When refreshing without a client_id, keep the original binding rather
  // than re-deriving it from an empty string.
  const idForBinding = clientId || `ref:${existingRef}`;

  const access = issueAccessToken({ clientId: idForBinding, scope, issuer, resource });
  const refreshToken = issueRefreshToken({ clientId: idForBinding, scope, issuer, resource });

  return Response.json(
    {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    },
    { headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } }
  );
}

async function readBody(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") || "";
  // Form encoding is what RFC 6749 specifies and what every client sends,
  // but accepting JSON costs three lines and saves an afternoon when a
  // hand-written curl call quietly posts the wrong thing.
  if (type.includes("application/json")) {
    try {
      const json = (await req.json()) as Record<string, string>;
      return new URLSearchParams(json);
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(await req.text());
}

function fail(error: string, description: string) {
  return Response.json(
    { error, error_description: description },
    { status: 400, headers: { "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" } }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
