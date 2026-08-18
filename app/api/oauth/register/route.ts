import { registerClient } from "@/lib/oauth/server";

/**
 * Dynamic Client Registration (RFC 7591).
 *
 * Open to anyone, as the spec intends: registering only produces an
 * identifier, and an identifier grants nothing. The access decision happens
 * one step later, at the consent screen, where a human has to type the
 * owner password. That is worth being clear about, because "anyone can
 * register" reads alarming until you notice that a registration cannot be
 * exchanged for a token without that step.
 */
export async function POST(req: Request) {
  let body: { client_name?: string; redirect_uris?: string[] };
  try {
    body = await req.json();
  } catch {
    return badRequest("invalid_client_metadata", "body must be JSON");
  }

  if (!Array.isArray(body.redirect_uris) || body.redirect_uris.length === 0) {
    return badRequest("invalid_redirect_uri", "redirect_uris is required");
  }

  try {
    const client = registerClient({
      client_name: body.client_name,
      redirect_uris: body.redirect_uris,
    });
    return Response.json(
      {
        client_id: client.client_id,
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: client.client_name,
        redirect_uris: client.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        // Public client: no secret is issued, so none can leak.
        token_endpoint_auth_method: "none",
      },
      { status: 201, headers: cors() }
    );
  } catch (err) {
    return badRequest("invalid_redirect_uri", err instanceof Error ? err.message : String(err));
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: cors() });
}

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  };
}

function badRequest(error: string, description: string) {
  return Response.json({ error, error_description: description }, { status: 400, headers: cors() });
}
