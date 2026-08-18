import { origin, ALL_SCOPES } from "@/lib/oauth/server";

/**
 * OAuth 2.0 Authorization Server Metadata (RFC 8414).
 *
 * Served at /.well-known/oauth-authorization-server via next.config.ts. The
 * client reads this to learn where to send the user and where to redeem the
 * code, which is why none of those paths need to be configured anywhere on
 * the client side.
 *
 * token_endpoint_auth_methods_supported is ["none"] because every client
 * here is a public client: an MCP client runs on the user's machine and
 * cannot keep a client secret. PKCE, not a secret, is what stops a stolen
 * code from being redeemed.
 */
export async function GET(req: Request) {
  const iss = origin(req);
  return Response.json(
    {
      issuer: iss,
      authorization_endpoint: `${iss}/api/oauth/authorize`,
      token_endpoint: `${iss}/api/oauth/token`,
      registration_endpoint: `${iss}/api/oauth/register`,
      scopes_supported: ALL_SCOPES,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      service_documentation: `${iss}/`,
    },
    {
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "public, max-age=3600",
      },
    }
  );
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type, MCP-Protocol-Version",
    },
  });
}
