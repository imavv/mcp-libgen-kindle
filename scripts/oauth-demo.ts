/**
 * Walks the whole OAuth handshake by hand, printing each step.
 *
 *   npm run oauth -- https://your-deployment.vercel.app
 *   npm run oauth                      # defaults to http://localhost:3000
 *
 * This is the same sequence a Claude connector performs silently on connect.
 * Doing it in a terminal is the point: every request, every parameter, and
 * the decoded contents of the tokens are printed, so the flow stops being a
 * black box that either works or says "couldn't sign in".
 *
 * It touches nothing destructive. The only tool it calls is send_to_kindle
 * with dry_run, which fetches and reports but never sends mail — and it is
 * called with a deliberately invalid file id, so even the fetch fails. The
 * point of that last call is to show what an insufficient_scope refusal
 * looks like when you decline kindle:send on the consent screen.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";

const BASE = (process.argv[2] || process.env.MCP_BASE_URL || "http://localhost:3000").replace(
  /\/$/,
  ""
);
const PORT = 53683;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

const step = (n: number, title: string) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
const show = (label: string, value: unknown) =>
  console.log(`   ${label}: ${typeof value === "string" ? value : JSON.stringify(value, null, 2).replace(/\n/g, "\n   ")}`);

/** Prints a JWT's payload. These are HS256, so the payload is just base64url. */
function peek(token: string): unknown {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return "(not a JWT)";
  }
}

async function main() {
  console.log(`\nOAuth walkthrough against ${BASE}\n${"─".repeat(60)}`);

  // ---------------------------------------------------------------- 401
  step(1, "Call the MCP endpoint with no credential at all");
  const denied = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  show("status", String(denied.status));
  show("WWW-Authenticate", denied.headers.get("www-authenticate") || "(absent)");
  console.log(
    "   ^ that resource_metadata parameter is the entire entry point.\n" +
      "     Everything below is the client following it."
  );

  // ---------------------------------------------------------- discovery
  step(2, "Fetch the protected resource metadata (RFC 9728)");
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  show("document", prm);

  step(3, "Fetch the authorization server metadata (RFC 8414)");
  const asMeta = await (
    await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)
  ).json();
  show("document", asMeta);

  // --------------------------------------------------------------- DCR
  step(4, "Register as a client (RFC 7591) — no credential needed, none granted");
  const reg = await (
    await fetch(asMeta.registration_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_name: "oauth-demo (terminal)", redirect_uris: [REDIRECT_URI] }),
    })
  ).json();
  if (!reg.client_id) {
    show("registration failed", reg);
    process.exit(1);
  }
  show("client_id (decoded)", peek(reg.client_id));

  // -------------------------------------------------------------- PKCE
  step(5, "Generate the PKCE pair");
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  show("code_verifier (stays here, never sent yet)", verifier);
  show("code_challenge (goes in the URL)", challenge);

  const state = randomBytes(8).toString("hex");
  const authUrl = new URL(asMeta.authorization_endpoint);
  authUrl.searchParams.set("client_id", reg.client_id);
  authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("code_challenge", challenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("resource", `${BASE}/api/mcp`);

  step(6, "Open this in a browser, approve, and come back");
  console.log(`\n   ${authUrl}\n`);
  console.log("   Try unticking kindle:send on that page — step 10 shows what happens.");

  const code = await waitForCode(state);
  show("authorization code (decoded)", peek(code));
  console.log("   ^ 60-second lifetime, bound to this client, redirect URI, and challenge.");

  // ------------------------------------------------------------- token
  step(7, "Exchange the code for tokens — the back channel, no browser involved");
  const tokenRes = await fetch(asMeta.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      code_verifier: verifier,
      client_id: reg.client_id,
      redirect_uri: REDIRECT_URI,
    }),
  });
  const tokens = await tokenRes.json();
  if (!tokens.access_token) {
    show("token exchange failed", tokens);
    process.exit(1);
  }
  show("scope granted", tokens.scope);
  show("expires_in", `${tokens.expires_in}s`);
  show("access token (decoded)", peek(tokens.access_token));

  step(8, "Prove the verifier matters: replay the same code with a wrong one");
  const replay = await (
    await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: randomBytes(32).toString("base64url"),
        client_id: reg.client_id,
        redirect_uri: REDIRECT_URI,
      }),
    })
  ).json();
  show("response", replay);

  // --------------------------------------------------------------- use
  step(9, "Call the MCP endpoint with the access token");
  const listed = await call(tokens.access_token, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
  });
  show("status", String(listed.status));
  show("body (truncated)", listed.body.slice(0, 400));

  step(10, "Call send_to_kindle — refused unless kindle:send was granted");
  const send = await call(tokens.access_token, {
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "send_to_kindle", arguments: { drive_file_id: "not-a-real-id", dry_run: true } },
  });
  show("status", String(send.status));
  show("WWW-Authenticate", send.headers.get("www-authenticate") || "(absent)");
  show("body (truncated)", send.body.slice(0, 400));

  step(11, "Refresh: swap the refresh token for a fresh access token");
  const refreshed = await (
    await fetch(asMeta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refresh_token,
        client_id: reg.client_id,
      }),
    })
  ).json();
  show("new access token expires at", new Date(((peek(refreshed.access_token) as { exp: number }).exp) * 1000).toISOString());
  console.log(
    "\n\x1b[1mDone.\x1b[0m Rotating OAUTH_SIGNING_KEY in the deployment invalidates every\n" +
      "token above at once — that is this server's only revocation mechanism.\n"
  );
}

async function call(token: string, body: unknown) {
  const res = await fetch(`${BASE}/api/mcp`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      // Streamable HTTP servers negotiate both; sending both keeps the
      // handler from rejecting the request before auth is even reached.
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, headers: res.headers, body: await res.text() };
}

/** Catches the browser redirect and hands back the ?code=. */
function waitForCode(expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${PORT}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        `<body style="font:16px system-ui;padding:3rem">${
          code ? "Code received — back to the terminal." : `Denied: ${error}`
        }</body>`
      );
      server.close();
      if (!code) return reject(new Error(error || "no code returned"));
      if (url.searchParams.get("state") !== expectedState) {
        return reject(new Error("state mismatch — this response is not from the request we made"));
      }
      resolve(code);
    });
    server.listen(PORT, () => console.log(`   (listening on ${REDIRECT_URI})`));
  });
}

main().catch((err) => {
  console.error(`\nFailed: ${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
