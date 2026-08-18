import {
  SCOPES,
  ALL_SCOPES,
  type Scope,
  issueCode,
  normalizeScope,
  origin,
  ownerPassword,
  readClient,
  resourceUrl,
} from "@/lib/oauth/server";
import { secretEquals } from "@/lib/oauth/jwt";

/**
 * The authorization endpoint — the only page in this system a human ever
 * looks at.
 *
 * GET renders the consent screen. POST checks the owner password and issues
 * an authorization code, delivered by redirecting the browser back to the
 * client with ?code=...
 *
 * Two classes of error are handled differently on purpose. If the client_id
 * or redirect_uri is bad, the error is rendered here as HTML: redirecting an
 * error to an unverified URI would make this endpoint into an open redirect.
 * Everything after those two checks pass is reported by redirecting back to
 * the client with ?error=..., which is what the client is waiting for.
 */

type Params = {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  scope: string | null;
  state: string | null;
  code_challenge: string | null;
  code_challenge_method: string | null;
  resource: string | null;
};

function readParams(src: URLSearchParams | FormData): Params {
  const get = (k: string) => {
    const v = src.get(k);
    return typeof v === "string" ? v : null;
  };
  return {
    client_id: get("client_id") || "",
    redirect_uri: get("redirect_uri") || "",
    response_type: get("response_type") || "code",
    scope: get("scope"),
    state: get("state"),
    code_challenge: get("code_challenge"),
    code_challenge_method: get("code_challenge_method"),
    resource: get("resource"),
  };
}

export async function GET(req: Request) {
  const p = readParams(new URL(req.url).searchParams);
  const checked = await validate(req, p);
  if (checked instanceof Response) return checked;
  return page({ params: p, clientName: checked.clientName, scopes: checked.scopes });
}

export async function POST(req: Request) {
  const form = await req.formData();
  const p = readParams(form);
  const checked = await validate(req, p);
  if (checked instanceof Response) return checked;

  if (form.get("action") === "deny") {
    return redirectBack(p, { error: "access_denied", error_description: "The owner declined." });
  }

  // The scopes actually granted are the ones still ticked on the form, which
  // may be fewer than the client asked for. Downgrading is always allowed;
  // ticking a box the client never requested is not.
  const granted = ALL_SCOPES.filter(
    (s) => checked.scopes.includes(s) && form.getAll("scope_grant").includes(s)
  );
  if (granted.length === 0) {
    return page({
      params: p,
      clientName: checked.clientName,
      scopes: checked.scopes,
      error: "Grant at least one permission, or press Deny.",
    });
  }

  const supplied = String(form.get("password") || "");
  if (!secretEquals(supplied, ownerPassword())) {
    // Nothing here stores failed attempts — there is no database — so a
    // deliberate delay is the only brute-force friction available. It also
    // keeps a wrong password from being distinguishable by response time.
    await new Promise((r) => setTimeout(r, 1000));
    return page({
      params: p,
      clientName: checked.clientName,
      scopes: checked.scopes,
      error: "Wrong password.",
      status: 401,
    });
  }

  const code = issueCode({
    clientId: p.client_id,
    redirectUri: p.redirect_uri,
    scope: granted.join(" "),
    codeChallenge: p.code_challenge!,
    resource: resourceUrl(req),
    issuer: origin(req),
  });

  return redirectBack(p, { code });
}

async function validate(
  req: Request,
  p: Params
): Promise<{ clientName: string; scopes: Scope[] } | Response> {
  if (!process.env.OAUTH_SIGNING_KEY || !process.env.OWNER_PASSWORD) {
    return errorPage(
      "Server not configured",
      "OAUTH_SIGNING_KEY and OWNER_PASSWORD must both be set in the deployment's " +
        "environment variables. Variables added after a deployment was built do not " +
        "reach it until you redeploy."
    );
  }

  let clientName: string;
  try {
    const client = readClient(p.client_id);
    if (!client.redirect_uris.includes(p.redirect_uri)) {
      return errorPage(
        "Bad redirect_uri",
        "That redirect URI was not part of this client's registration, so the code " +
          "will not be sent to it."
      );
    }
    clientName = client.client_name;
  } catch {
    return errorPage(
      "Unknown client",
      "The client_id is not one this server issued, or it was signed with a key " +
        "that has since been rotated. Reconnect the client so it registers again."
    );
  }

  if (p.response_type !== "code") {
    return redirectBack(p, {
      error: "unsupported_response_type",
      error_description: "Only the authorization code flow is supported.",
    });
  }

  // PKCE is mandatory, not negotiated. Without it, anyone who captures the
  // redirect — a shoulder-surfed URL bar, a browser extension, a proxy log —
  // can redeem the code themselves.
  if (!p.code_challenge || p.code_challenge_method !== "S256") {
    return redirectBack(p, {
      error: "invalid_request",
      error_description: "PKCE with code_challenge_method=S256 is required.",
    });
  }

  // RFC 8707: the client says which resource the token is for, and this
  // server refuses to mint tokens aimed anywhere else. That is what stops a
  // token issued here from being replayed against a different MCP server.
  if (p.resource) {
    const canonical = resourceUrl(req);
    const asked = p.resource.replace(/\/$/, "");
    if (asked !== canonical && asked !== origin(req)) {
      return redirectBack(p, {
        error: "invalid_target",
        error_description: `This server only issues tokens for ${canonical}.`,
      });
    }
  }

  const scopes = normalizeScope(p.scope);
  if (scopes.length === 0) {
    return redirectBack(p, {
      error: "invalid_scope",
      error_description: `Supported scopes: ${ALL_SCOPES.join(", ")}.`,
    });
  }

  return { clientName, scopes };
}

function redirectBack(p: Params, extra: Record<string, string>) {
  const url = new URL(p.redirect_uri);
  for (const [k, v] of Object.entries(extra)) url.searchParams.set(k, v);
  // state is echoed untouched; it is the client's CSRF defence, not ours.
  if (p.state) url.searchParams.set("state", p.state);
  return Response.redirect(url.toString(), 302);
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function html(body: string, status = 200) {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Authorize — mcp-libgen-kindle</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, sans-serif;
         max-width: 34rem; margin: 3rem auto; padding: 0 1.25rem; }
  h1 { font-size: 1.35rem; margin-bottom: .25rem; }
  .sub { opacity: .7; margin-top: 0; }
  .card { border: 1px solid color-mix(in srgb, currentColor 22%, transparent);
          border-radius: 10px; padding: 1rem 1.15rem; margin: 1.25rem 0; }
  label.scope { display: flex; gap: .6rem; align-items: flex-start; margin: .6rem 0; }
  label.scope span b { display: block; font-family: ui-monospace, SFMono-Regular, monospace;
                       font-size: .85rem; }
  input[type=password] { width: 100%; padding: .5rem .6rem; font-size: 1rem;
                         border-radius: 7px; border: 1px solid color-mix(in srgb, currentColor 35%, transparent);
                         background: transparent; color: inherit; }
  .row { display: flex; gap: .6rem; margin-top: 1rem; }
  button { font: inherit; padding: .55rem 1.1rem; border-radius: 7px; cursor: pointer;
           border: 1px solid color-mix(in srgb, currentColor 35%, transparent); background: transparent; color: inherit; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
  .err { color: #b91c1c; font-weight: 600; }
  code { font-size: .85rem; word-break: break-all; }
</style></head><body>${body}</body></html>`,
    { status, headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } }
  );
}

function errorPage(title: string, detail: string) {
  return html(`<h1>${esc(title)}</h1><p>${esc(detail)}</p>`, 400);
}

function page(opts: {
  params: Params;
  clientName: string;
  scopes: Scope[];
  error?: string;
  status?: number;
}) {
  const { params: p, clientName, scopes } = opts;
  const hidden = Object.entries({
    client_id: p.client_id,
    redirect_uri: p.redirect_uri,
    response_type: p.response_type,
    scope: p.scope ?? "",
    state: p.state ?? "",
    code_challenge: p.code_challenge ?? "",
    code_challenge_method: p.code_challenge_method ?? "",
    resource: p.resource ?? "",
  })
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`)
    .join("");

  const boxes = scopes
    .map(
      (s) =>
        `<label class="scope"><input type="checkbox" name="scope_grant" value="${s}" checked>
         <span><b>${s}</b>${esc(SCOPES[s])}</span></label>`
    )
    .join("");

  return html(
    `<h1>${esc(clientName)} wants access</h1>
     <p class="sub">to your libgen &rarr; Kindle server</p>
     <form method="post">
       ${hidden}
       <div class="card">
         ${boxes}
         <p class="sub" style="font-size:.85rem">Untick anything you would rather not grant.
            The token is issued with exactly what stays ticked.</p>
       </div>
       <div class="card">
         <label for="pw"><b>Owner password</b></label>
         <p class="sub" style="font-size:.85rem;margin:.2rem 0 .6rem">
           Redirects to <code>${esc(p.redirect_uri)}</code></p>
         <input id="pw" type="password" name="password" autocomplete="current-password" autofocus>
         ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ""}
         <div class="row">
           <button class="primary" type="submit" name="action" value="approve">Approve</button>
           <button type="submit" name="action" value="deny">Deny</button>
         </div>
       </div>
     </form>`,
    opts.status ?? 200
  );
}
