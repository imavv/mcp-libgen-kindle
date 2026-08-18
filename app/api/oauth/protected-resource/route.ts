import { origin, resourceUrl, ALL_SCOPES } from "@/lib/oauth/server";

/**
 * OAuth 2.0 Protected Resource Metadata (RFC 9728).
 *
 * Served at /.well-known/oauth-protected-resource via a rewrite in
 * next.config.ts. This is the document the 401 from /api/mcp points at, and
 * it answers exactly one question for the client: which authorization server
 * is allowed to issue tokens for this resource. Here that is the same
 * deployment, but the indirection is what lets the two halves live apart.
 */

function metadata(req: Request) {
  return {
    resource: resourceUrl(req),
    authorization_servers: [origin(req)],
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin(req)}/`,
  };
}

export async function GET(req: Request) {
  return Response.json(metadata(req), {
    headers: {
      // Discovery happens from a browser-based client often enough that CORS
      // has to be open here, and the document is public by design.
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=3600",
    },
  });
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
