/**
 * Non-destructive preflight check.
 *
 *   npm run check
 *
 * Validates every credential without causing a side effect: no files are
 * written to Drive, no email is sent. Worth running before a deploy and again
 * whenever something starts failing, since most failures in this system are
 * credential problems that surface far from their cause.
 */
import { readFileSync } from "node:fs";
import { google } from "googleapis";
import nodemailer from "nodemailer";

function loadEnv(path: string) {
  try {
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch {
    /* fine — vars may already be exported */
  }
}

loadEnv(".env.local");
loadEnv(".env");

let failures = 0;
const pass = (msg: string) => console.log(`  ok    ${msg}`);
const warn = (msg: string) => console.log(`  warn  ${msg}`);
const fail = (msg: string) => {
  failures++;
  console.log(`  FAIL  ${msg}`);
};

async function checkEnv() {
  console.log("\nEnvironment");
  const required = [
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
    "GOOGLE_REFRESH_TOKEN",
    "SENDER_EMAIL",
    "KINDLE_EMAIL",
    "GMAIL_APP_PASSWORD",
  ];
  for (const key of required) {
    if (process.env[key]) pass(key);
    else fail(`${key} is not set`);
  }

  const kindle = process.env.KINDLE_EMAIL || "";
  if (kindle && !/@kindle\.com$/i.test(kindle)) {
    fail(`KINDLE_EMAIL "${kindle}" does not end in @kindle.com`);
  }

  // Gmail app passwords are 16 characters. Google displays them in groups of
  // four, and pasting the display form with spaces is a common silent failure.
  const app = process.env.GMAIL_APP_PASSWORD || "";
  if (app && app.includes(" ")) {
    fail("GMAIL_APP_PASSWORD contains spaces — remove them (Google shows it in groups of 4)");
  } else if (app && app.length !== 16) {
    fail(`GMAIL_APP_PASSWORD is ${app.length} chars, expected 16 — is this an app password, not your account password?`);
  }
}

/**
 * The MCP endpoint's own auth. Nothing here talks to the network — it is all
 * local sanity checks, but they catch the two failures that otherwise show up
 * as an unexplained sign-in error in the client.
 */
function checkMcpAuth() {
  console.log("\nMCP endpoint auth");

  const key = process.env.OAUTH_SIGNING_KEY || "";
  if (!key) {
    fail("OAUTH_SIGNING_KEY is not set — the OAuth flow cannot issue or verify anything");
  } else if (key.length < 32) {
    fail(`OAUTH_SIGNING_KEY is ${key.length} chars; use at least 32 (openssl rand -hex 32)`);
  } else {
    pass(`OAUTH_SIGNING_KEY (${key.length} chars)`);
  }

  const pw = process.env.OWNER_PASSWORD || "";
  if (!pw) {
    fail("OWNER_PASSWORD is not set — the consent screen has nothing to check against");
  } else if (pw.length < 12) {
    warn(`OWNER_PASSWORD is only ${pw.length} chars. It is the one credential standing ` +
      "between a stranger and your Kindle, and the consent page is public.");
  } else {
    pass(`OWNER_PASSWORD (${pw.length} chars)`);
  }

  // Not a failure: the static token is a deliberate fallback. But it is the
  // weakest way in, so its presence is worth stating out loud every run.
  if (process.env.MCP_AUTH_TOKEN) {
    warn(
      "MCP_AUTH_TOKEN is set. /api/mcp still accepts it, with every scope and no " +
        "expiry, including as ?token= in the URL. Unset it once OAuth works."
    );
  } else {
    pass("MCP_AUTH_TOKEN is unset — OAuth is the only way into /api/mcp");
  }
}

async function checkDrive() {
  console.log("\nGoogle Drive");
  if (!process.env.GOOGLE_REFRESH_TOKEN) {
    fail("skipped — no refresh token");
    return;
  }

  try {
    const auth = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET
    );
    auth.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });

    const token = await auth.getAccessToken();
    if (!token.token) throw new Error("no access token returned");
    pass("refresh token exchanged for an access token");

    const drive = google.drive({ version: "v3", auth });
    // Read-only. Under the drive.file scope this only ever sees files this app
    // created, so an empty list on a fresh setup is the expected result.
    const res = await drive.files.list({ pageSize: 5, fields: "files(id,name)" });
    const count = res.data.files?.length ?? 0;
    pass(`Drive API reachable (${count} app-created file${count === 1 ? "" : "s"} visible)`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`Drive auth failed: ${msg}`);
    if (/invalid_grant/i.test(msg)) {
      console.log(
        "        invalid_grant usually means the refresh token was revoked or expired.\n" +
          "        If the OAuth consent screen is still in Testing status, tokens expire\n" +
          "        after 7 days — publish the app, then run `npm run auth` again."
      );
    }
  }
}

async function checkSmtp() {
  console.log("\nGmail SMTP");
  if (!process.env.GMAIL_APP_PASSWORD) {
    fail("skipped — no app password");
    return;
  }

  const transporter = nodemailer.createTransport({
    host: "smtp.gmail.com",
    port: 587,
    secure: false,
    auth: { user: process.env.SENDER_EMAIL, pass: process.env.GMAIL_APP_PASSWORD },
    connectionTimeout: 15_000,
  });

  try {
    // Connects and authenticates, then disconnects. Sends nothing.
    await transporter.verify();
    pass(`authenticated as ${process.env.SENDER_EMAIL}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    fail(`SMTP auth failed: ${msg}`);
    if (/username and password not accepted|invalid credentials/i.test(msg)) {
      console.log(
        "        Gmail rejects account passwords over SMTP. Generate an app password\n" +
          "        at myaccount.google.com/apppasswords (requires 2FA enabled)."
      );
    }
  }
}

async function main() {
  await checkEnv();
  checkMcpAuth();
  await checkDrive();
  await checkSmtp();

  console.log(
    failures === 0
      ? "\nAll checks passed.\n\nNot checkable from here: whether SENDER_EMAIL is on Amazon's\n" +
          "Approved Personal Document E-mail List. If sends succeed but nothing\n" +
          "reaches the device, that is the first thing to verify.\n"
      : `\n${failures} check${failures === 1 ? "" : "s"} failed.\n`
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
