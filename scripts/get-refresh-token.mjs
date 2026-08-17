#!/usr/bin/env node
/**
 * One-time local OAuth consent to mint a Google Drive refresh token.
 *
 * Vercel functions have no browser, so the consent flow has to happen here on
 * your machine once. The refresh token it prints goes into the Vercel env vars
 * and the function exchanges it for short-lived access tokens at runtime.
 *
 *   npm run auth
 *
 * Two things that will otherwise bite you later:
 *
 *  - access_type=offline plus prompt=consent is what actually mints a refresh
 *    token. Without prompt=consent, Google returns one only on the very first
 *    authorisation and silently omits it on every subsequent run.
 *
 *  - If your OAuth consent screen is still in "Testing" status, the refresh
 *    token expires after 7 days and the server breaks weekly with a confusing
 *    error. Set the consent screen to "In production" before running this.
 *    The drive.file scope is not a restricted scope, so publishing does not
 *    require Google's verification review.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { google } from "googleapis";

const PORT = 53682;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;

// Per-file access: this app can only touch files it created itself. Narrower
// than full drive scope, and it keeps you out of the verification queue.
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

function loadEnvFile(path) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    // No .env.local is fine as long as the vars are already exported.
  }
}

/**
 * Google hands you credentials.json with the client nested under either "web"
 * (Web application) or "installed" (Desktop app). Both work here, but a "web"
 * client will only accept a redirect URI that is registered against it, so the
 * loopback address below has to be added in the console first.
 */
function loadCredentialsFile(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const client = parsed.web || parsed.installed;
    if (!client?.client_id || !client?.client_secret) return null;
    return { ...client, kind: parsed.web ? "web" : "installed" };
  } catch {
    return null;
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

const fromFile = loadCredentialsFile("credentials.json");
const clientId = process.env.GOOGLE_CLIENT_ID || fromFile?.client_id;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET || fromFile?.client_secret;

if (!clientId || !clientSecret) {
  console.error(
    "No OAuth client found.\n\n" +
      "Either put credentials.json in the project root, or set GOOGLE_CLIENT_ID\n" +
      "and GOOGLE_CLIENT_SECRET in .env.local.\n\n" +
      "Google Cloud Console -> APIs & Services -> Credentials -> Create credentials\n" +
      "  -> OAuth client ID"
  );
  process.exit(1);
}

if (fromFile) {
  console.log(`Using credentials.json (${fromFile.kind} client, project ${fromFile.project_id}).`);
  const registered = fromFile.redirect_uris || [];
  if (fromFile.kind === "web" && !registered.includes(REDIRECT_URI)) {
    console.log(
      `\nNote: ${REDIRECT_URI} is not in this client's authorised redirect URIs.\n` +
        "Add it under Credentials -> your OAuth client -> Authorised redirect URIs,\n" +
        "or the consent screen will fail with redirect_uri_mismatch.\n"
    );
  }
}

const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);

const authUrl = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: SCOPES,
});

const server = createServer(async (req, res) => {
  if (!req.url?.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }

  const code = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("No authorisation code in callback.");
    return;
  }

  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Done. You can close this tab and return to the terminal.");

    if (!tokens.refresh_token) {
      console.error(
        "\nGoogle did not return a refresh token. This usually means a previous\n" +
          "authorisation is still active. Revoke it at\n" +
          "https://myaccount.google.com/permissions and run this again."
      );
      process.exit(1);
    }

    console.log("\nAdd this to .env.local and to your Vercel environment variables:\n");
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
    console.log("Treat it like a password. Do not commit it or paste it into chat.");
    process.exit(0);
  } catch (err) {
    res.writeHead(500).end("Token exchange failed. See terminal.");
    console.error(err);
    process.exit(1);
  }
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(
      `Port ${PORT} is already in use — something else is holding the callback\n` +
        "address. Close the other process and run this again.\n\n" +
        "  Windows:  Get-NetTCPConnection -LocalPort 53682 -State Listen\n" +
        "  macOS/Linux:  lsof -i :53682"
    );
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Listening on ${REDIRECT_URI}`);
  console.log("Keep this terminal open until you have finished approving.\n");
  console.log("Open this URL in your browser to authorise:\n");
  console.log(authUrl + "\n");
});
