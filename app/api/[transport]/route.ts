import { createMcpHandler } from "mcp-handler";
import { z } from "zod";
import { config } from "@/lib/config";
import { searchLibgen, toMarkdown, formatBytes } from "@/lib/libgen/search";
import { downloadByMd5 } from "@/lib/libgen/download";
import { buildFilename } from "@/lib/epub/validate";
import { uploadEpub, downloadEpub, listLibrary } from "@/lib/storage/drive";
import { sendToKindle } from "@/lib/email/kindle";
import {
  ALL_SCOPES,
  TOOL_SCOPES,
  origin,
  readTyped,
  resourceUrl,
} from "@/lib/oauth/server";
import { secretEquals } from "@/lib/oauth/jwt";

/**
 * Downloads from libgen mirrors are routinely slow, so this wants to be as
 * high as the plan allows. 60 is the Hobby ceiling; Vercel fails the whole
 * deployment rather than clamping if you exceed it, so this stays at the safe
 * value. On Pro, raise it to 300 here and in app/selftest/route.ts.
 *
 * The per-fetch timeout in lib/config.ts is deliberately set below this so a
 * single slow mirror fails over instead of consuming the whole invocation.
 */
export const maxDuration = 60;

function text(body: string) {
  return { content: [{ type: "text" as const, text: body }] };
}

function errorText(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: `Error: ${message}` }], isError: true };
}

const handler = createMcpHandler(
  (server) => {
    server.tool(
      "search_libgen",
      "Search Library Genesis for ebook files and return a table of candidates. " +
        "Choose one row and pass its md5 to download_book. Prefer a candidate whose " +
        "title matches the actual work requested — results often include study guides, " +
        "omnibus collections, and abridgements alongside the real book. libgen does " +
        "not report language, so judge it from the title and author. Very small files " +
        "for a full-length work are often stubs.",
      {
        query: z.string().describe("Title, author, or both. e.g. 'of mice and men steinbeck'"),
        extension: z
          .string()
          .optional()
          .default("epub")
          .describe("File extension filter. Defaults to epub for Kindle compatibility."),
        limit: z.number().int().min(1).max(50).optional().default(15),
      },
      async ({ query, extension, limit }) => {
        try {
          const result = await searchLibgen(query, { extension, limit });
          return text(toMarkdown(result));
        } catch (err) {
          return errorText(err);
        }
      }
    );

    server.tool(
      "download_book",
      "Download an ebook from libgen by md5 and store it in Google Drive. The " +
        "file is validated as a real EPUB before it is stored. This tool does " +
        "NOT send anything to the Kindle — it deliberately stops after storing. " +
        "When it returns, show the user the preview link and ask whether they " +
        "want it sent, then wait for their answer.",
      {
        md5: z.string().regex(/^[a-fA-F0-9]{32}$/).describe("md5 from a search_libgen row"),
        title: z.string().optional().describe("Title from the search row — becomes the Kindle title"),
        author: z.string().optional().describe("Author from the search row"),
      },
      async ({ md5, title, author }) => {
        try {
          const { buffer, sourceUrl, bytes } = await downloadByMd5(md5.toLowerCase());
          const filename = buildFilename(title || md5, author || "");
          const stored = await uploadEpub(buffer, filename);

          // Deliberately does not tell the model to call send_to_kindle next.
          // An earlier version ended with "Next: call send_to_kindle with
          // drive_file_id=..." and the model chained straight through to
          // sending, with no chance for the user to look at the file first.
          // Sending is the irreversible step here, so the stopping instruction
          // lives in the tool result where the model reads it every time.
          return text(
            [
              `Downloaded and stored — NOT yet sent to Kindle.`,
              "",
              `File: ${stored.filename} (${formatBytes(bytes)})`,
              stored.webViewLink ? `Preview: ${stored.webViewLink}` : "",
              `Drive file id: ${stored.fileId}`,
              `Source: ${sourceUrl}`,
              "",
              "Show the user the preview link so they can check the file, then " +
                "ask whether they want it sent to their Kindle. Do not call " +
                "send_to_kindle until they have answered yes.",
            ]
              .filter(Boolean)
              .join("\n")
          );
        } catch (err) {
          return errorText(err);
        }
      }
    );

    server.tool(
      "send_to_kindle",
      "Email a stored EPUB from Google Drive to the configured Kindle address. " +
        "REQUIRES EXPLICIT USER CONFIRMATION: only call this after the user has " +
        "been asked whether to send this specific file and has answered yes. " +
        "Never call it as an automatic follow-up to download_book — sending is " +
        "irreversible and the user may want to check the file first. A request " +
        "to find or download a book is not on its own permission to send it. " +
        "Amazon gives no delivery confirmation, so success here means the message " +
        "was accepted by the mail server, not that the book has appeared on the device.",
      {
        drive_file_id: z.string().describe("Drive file id from download_book"),
        dry_run: z
          .boolean()
          .optional()
          .default(false)
          .describe("Fetch and report the file without sending the email"),
      },
      async ({ drive_file_id, dry_run }) => {
        try {
          const { buffer, filename } = await downloadEpub(drive_file_id);

          if (dry_run) {
            return text(
              `Dry run — not sent.\nFile: ${filename}\nSize: ${formatBytes(buffer.length)}\n` +
                `Would send from ${config.kindle.sender()} to ${config.kindle.to()}.`
            );
          }

          const result = await sendToKindle(buffer, filename);
          if (result.rejected.length > 0) {
            return errorText(
              new Error(`SMTP rejected: ${result.rejected.join(", ")}`)
            );
          }

          return text(
            [
              `Sent "${result.filename}" (${formatBytes(result.bytes)}) to ${config.kindle.to()}.`,
              `Message id: ${result.messageId}`,
              "",
              "Amazon does not acknowledge personal document delivery, so this confirms " +
                "the email was accepted for delivery — not that the book has synced. " +
                "If it does not appear within a few minutes, the usual cause is that " +
                `${config.kindle.sender()} is not on your Amazon Approved Personal ` +
                "Document E-mail List.",
            ].join("\n")
          );
        } catch (err) {
          return errorText(err);
        }
      }
    );

    server.tool(
      "list_library",
      "List EPUBs already stored in Google Drive by this server, newest first. " +
        "Use this to re-send a book without downloading it again.",
      { limit: z.number().int().min(1).max(100).optional().default(25) },
      async ({ limit }) => {
        try {
          const files = await listLibrary(limit);
          if (files.length === 0) return text("Library is empty.");
          return text(
            files
              .map((f) => `- ${f.filename} (${formatBytes(f.bytes)}) — id: ${f.fileId}`)
              .join("\n")
          );
        } catch (err) {
          return errorText(err);
        }
      }
    );
  },
  {},
  {
    // mcp-handler derives its endpoints from this plus the [transport] segment,
    // so this file must live at app/api/[transport]/route.ts. The served
    // endpoint is /api/mcp.
    basePath: "/api",
    // Streamable HTTP only. The SSE transport needs Redis attached to hold
    // session state, which buys nothing for a single-user server.
    disableSse: true,
    maxDuration,
    verboseLogs: process.env.NODE_ENV !== "production",
  }
);

/**
 * This endpoint downloads files and sends mail from a personal Gmail account,
 * so it must not be open to the internet.
 *
 * There are two ways in, and they are not equivalent.
 *
 * 1. An OAuth 2.1 access token in the Authorization header. This is the
 *    normal path. The token is a short-lived JWT this deployment issued to a
 *    client the owner approved by hand, it names the scopes that were
 *    granted, and it expires in an hour. See lib/oauth/server.ts.
 *
 * 2. The static MCP_AUTH_TOKEN, in the header or as ?token=. This is the old
 *    scheme, kept as a fallback so a broken OAuth flow cannot lock the owner
 *    out of their own server, and so curl and npm run check keep working
 *    without a browser redirect. It is the weaker credential and it defines
 *    the real security of this endpoint while it remains enabled: it never
 *    expires, it carries every scope, and in the query-string form it lands
 *    in Vercel's access logs. Unset MCP_AUTH_TOKEN in the deployment to
 *    close it off once OAuth is connected and working.
 *
 * On failure this replies 401 with a WWW-Authenticate header pointing at the
 * protected-resource metadata. That header is what makes OAuth discovery
 * start — an earlier version of this file deliberately withheld it, because
 * without an authorization server behind it the client's discovery attempt
 * only produced a confusing sign-in error. Now there is one, so the header
 * is the entry point rather than a dead end.
 */

const RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";

type Granted = { scopes: Set<string>; via: "oauth" | "static-key" };

function challenge(req: Request, error: string, description: string, scope?: string) {
  const params = [
    'realm="mcp-libgen-kindle"',
    `error="${error}"`,
    `error_description="${description.replace(/"/g, "'")}"`,
    scope ? `scope="${scope}"` : "",
    `resource_metadata="${origin(req)}${RESOURCE_METADATA_PATH}"`,
  ].filter(Boolean);
  return params.join(", ");
}

function unauthorized(req: Request, description: string) {
  return new Response(JSON.stringify({ error: "invalid_token", error_description: description }), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer ${challenge(req, "invalid_token", description)}`,
    },
  });
}

function authenticate(req: Request): Granted | Response {
  const header = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim();
  const query = new URL(req.url).searchParams.get("token")?.trim();
  const presented = header || query;

  if (!presented) {
    return unauthorized(req, "No access token supplied.");
  }

  const staticToken = process.env.MCP_AUTH_TOKEN;
  if (staticToken && secretEquals(presented, staticToken)) {
    return { scopes: new Set<string>(ALL_SCOPES), via: "static-key" };
  }

  if (!process.env.OAUTH_SIGNING_KEY) {
    return new Response(
      "Neither OAUTH_SIGNING_KEY nor a matching MCP_AUTH_TOKEN is set on the server, so " +
        "no credential can be verified. Set them in the Vercel project's environment " +
        "variables, then redeploy — existing deployments do not pick up variables added " +
        "after they were built.",
      { status: 503 }
    );
  }

  let claims;
  try {
    claims = readTyped(presented, "access");
  } catch (err) {
    return unauthorized(req, err instanceof Error ? err.message : "Token rejected.");
  }

  // Audience and issuer are checked here rather than in verifyJwt because a
  // valid signature only proves this server minted the token — not that it
  // minted it for this resource. Skipping this is how a token handed to one
  // MCP server gets replayed against another.
  if (claims.aud !== resourceUrl(req)) {
    return unauthorized(req, `Token audience ${claims.aud} is not ${resourceUrl(req)}.`);
  }
  if (claims.iss !== origin(req)) {
    return unauthorized(req, `Token issuer ${claims.iss} is not ${origin(req)}.`);
  }

  return {
    scopes: new Set(String(claims.scope || "").split(/\s+/).filter(Boolean)),
    via: "oauth",
  };
}

/**
 * Which scopes this particular JSON-RPC body needs.
 *
 * Scope is enforced per tool rather than per endpoint, which means reading
 * the request body before handing it on. The point is send_to_kindle: a
 * connection can hold every other permission and still be unable to push a
 * document to the device, because that is the one step nothing can undo.
 */
async function scopesNeeded(req: Request): Promise<{ scopes: Set<string>; id: unknown }> {
  const needed = new Set<string>();
  let id: unknown = null;
  if (req.method !== "POST") return { scopes: needed, id };

  try {
    // clone() so the body is still readable by the MCP handler afterwards.
    const body = await req.clone().json();
    for (const call of Array.isArray(body) ? body : [body]) {
      if (call?.method !== "tools/call") continue;
      if (id === null) id = call?.id ?? null;
      const scope = TOOL_SCOPES[call?.params?.name];
      if (scope) needed.add(scope);
    }
  } catch {
    // Unparseable body: let the MCP handler produce the protocol-level error.
  }
  return { scopes: needed, id };
}

function withAuth(inner: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    const auth = authenticate(req);
    if (auth instanceof Response) return auth;

    const { scopes: needed, id } = await scopesNeeded(req);
    const missing = [...needed].filter((s) => !auth.scopes.has(s));
    if (missing.length > 0) {
      const description = `This token was not granted ${missing.join(", ")}.`;
      return new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: id ?? null,
          error: { code: -32001, message: `${description} Reconnect and approve it to continue.` },
        }),
        {
          // 403 with insufficient_scope is what RFC 6750 asks for; the
          // JSON-RPC error body is there so a client that reads the payload
          // instead of the status still gets told which scope was missing.
          status: 403,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate": `Bearer ${challenge(req, "insufficient_scope", description, missing.join(" "))}`,
          },
        }
      );
    }

    return inner(req);
  };
}

const guarded = withAuth(handler);

export { guarded as GET, guarded as POST, guarded as DELETE };
