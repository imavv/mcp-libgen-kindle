function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

export const config = {
  mcpAuthToken: () => required("MCP_AUTH_TOKEN"),

  google: {
    clientId: () => required("GOOGLE_CLIENT_ID"),
    clientSecret: () => required("GOOGLE_CLIENT_SECRET"),
    refreshToken: () => required("GOOGLE_REFRESH_TOKEN"),
    folderId: () => process.env.GOOGLE_DRIVE_FOLDER_ID || undefined,
    folderName: () => process.env.GOOGLE_DRIVE_FOLDER_NAME || "Kindle Library",
  },

  kindle: {
    sender: () => required("SENDER_EMAIL"),
    to: () => required("KINDLE_EMAIL"),
    appPassword: () => required("GMAIL_APP_PASSWORD"),
  },

  mirrors: (): string[] =>
    (process.env.LIBGEN_MIRRORS || "https://libgen.li")
      .split(",")
      .map((m) => m.trim().replace(/\/$/, ""))
      .filter(Boolean),
};

/**
 * Per-request timeout for any single outbound fetch.
 *
 * Kept well under the route's maxDuration so one slow mirror fails over
 * instead of eating the whole function budget. Vercel kills the invocation
 * with no partial result, so we would rather give up early and try the
 * next mirror.
 *
 * This covers reading the response body too, so it trades off against large
 * files: 18s is about 280 kB/s for a 5 MB epub. Erring low is deliberate —
 * a mirror that silently drops the connection costs a full timeout each
 * attempt, and getting through more mirrors beats waiting on a dead one.
 */
export const FETCH_TIMEOUT_MS = 18_000;

/** Browser-ish UA. Some mirrors 403 the default fetch agent. */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        ...(init.headers || {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
