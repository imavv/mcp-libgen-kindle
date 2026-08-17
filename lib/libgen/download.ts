import { config, fetchWithTimeout, FETCH_TIMEOUT_MS } from "../config";
import { validateEpub } from "../epub/validate";

/**
 * Download endpoints vary by mirror and by fork, and the exact one that works
 * moves around. Rather than encode a single guess, we try each shape, follow
 * one level of intermediate page, and accept whichever first yields bytes that
 * validate. Adding a new mirror shape later is a one-line change here.
 */
/**
 * ads.php is the real entry point. get.php without a key just redirects here,
 * so it is only kept as a fallback for mirrors that serve the file directly.
 */
const DOWNLOAD_PATHS = [
  (mirror: string, md5: string) => `${mirror}/ads.php?md5=${md5}`,
  (mirror: string, md5: string) => `${mirror}/get.php?md5=${md5}`,
];

/**
 * The download link on the ads page, which carries a per-request key:
 *   get.php?md5=<md5>&key=BC0RO3IV1BPY0SHN
 *
 * The key differs on every fetch, so it has to be read from the page we just
 * loaded and used immediately — it cannot be cached or constructed.
 *
 * This pattern is deliberately narrow. A looser one that also matched "cdn."
 * and "download" picked up the page's own bootstrap.min.css from jsDelivr and
 * fed the stylesheet to the epub validator.
 */
const KEYED_LINK_RE = /href\s*=\s*["']([^"']*get\.php\?[^"']*\bkey=[^"']*)["']/gi;

/** Fallback for mirrors using a different shape, still excluding page assets. */
const FALLBACK_LINK_RE =
  /href\s*=\s*["']([^"']*(?:get\.php\?[^"']*md5=|\/main\/[0-9a-f]{32}|\.epub)[^"']*)["']/gi;

/** Static assets that must never be mistaken for the book. */
const ASSET_PATH_RE = /\.(css|js|png|jpe?g|gif|ico|svg|woff2?|ttf|webp)(\?|#|$)/i;
const ASSET_TYPE_RE = /text\/css|javascript|^image\/|^font\/|^text\/plain/i;

const MAX_BYTES = 50 * 1024 * 1024; // Amazon's per-message attachment ceiling.

export interface DownloadResult {
  buffer: Buffer;
  sourceUrl: string;
  bytes: number;
}

function absolutise(href: string, base: string): string {
  try {
    return new URL(href, base).toString();
  } catch {
    return href;
  }
}

async function readBody(res: Response): Promise<Buffer> {
  const len = Number.parseInt(res.headers.get("content-length") || "0", 10);
  if (len > MAX_BYTES) {
    throw new Error(
      `File is ${(len / 1024 / 1024).toFixed(1)} MB, over the 50 MB Kindle attachment limit.`
    );
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) {
    throw new Error(
      `File is ${(buf.length / 1024 / 1024).toFixed(1)} MB, over the 50 MB Kindle attachment limit.`
    );
  }
  return buf;
}

/** Fetch a URL and, if it hands back an HTML page, follow one link from it. */
async function fetchFileOrFollow(
  url: string,
  referer: string,
  timeoutMs: number
): Promise<{ buffer: Buffer; url: string } | null> {
  const res = await fetchWithTimeout(
    url,
    { headers: { Referer: referer }, redirect: "follow" },
    timeoutMs
  );
  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") || "";
  if (ASSET_TYPE_RE.test(contentType)) return null;

  if (!contentType.includes("text/html")) {
    const buffer = await readBody(res);
    return { buffer, url: res.url || url };
  }

  const html = await res.text();
  const base = res.url || url;

  // Keyed links first: on libgen.li that is the only one that yields a file.
  const seen = new Set<string>();
  const targets: string[] = [];
  for (const re of [KEYED_LINK_RE, FALLBACK_LINK_RE]) {
    re.lastIndex = 0;
    for (const m of html.matchAll(re)) {
      const target = absolutise(m[1], base);
      if (seen.has(target) || target === url || ASSET_PATH_RE.test(target)) continue;
      seen.add(target);
      targets.push(target);
    }
  }

  for (const target of targets) {
    const inner = await fetchWithTimeout(
      target,
      { headers: { Referer: base }, redirect: "follow" },
      timeoutMs
    );
    if (!inner.ok) continue;

    const innerType = inner.headers.get("content-type") || "";
    if (innerType.includes("text/html") || ASSET_TYPE_RE.test(innerType)) continue;

    const buffer = await readBody(inner);
    return { buffer, url: inner.url || target };
  }
  return null;
}

/**
 * Total time to spend across every mirror and path shape.
 *
 * The route's maxDuration is 60s on Hobby, and Vercel kills the invocation
 * outright when it expires — no partial result, no error we can return. With
 * four mirrors times four path shapes there are sixteen possible attempts, so
 * without a shared deadline a few slow mirrors would consume the budget before
 * reaching a working one. Better to give up cleanly and report what we tried.
 */
const TOTAL_BUDGET_MS = 50_000;

/** Below this there is no point starting another attempt. */
const MIN_ATTEMPT_MS = 6_000;

/**
 * Fetch an epub by md5, validating the bytes before returning them.
 *
 * Returns the buffer rather than writing to disk: on Vercel the only writable
 * path is /tmp, which is not guaranteed to survive to the next invocation.
 * Persistence is the storage layer's job.
 */
export async function downloadByMd5(
  md5: string,
  budgetMs = TOTAL_BUDGET_MS
): Promise<DownloadResult> {
  const attempts: string[] = [];
  const mirrors = config.mirrors();
  const deadline = Date.now() + budgetMs;

  for (const mirror of mirrors) {
    for (const buildPath of DOWNLOAD_PATHS) {
      const remaining = deadline - Date.now();
      if (remaining < MIN_ATTEMPT_MS) {
        attempts.push(`gave up after ${Math.round(budgetMs / 1000)}s budget exhausted`);
        return failed(md5, attempts);
      }

      const url = buildPath(mirror, md5);
      try {
        const got = await fetchFileOrFollow(
          url,
          `${mirror}/`,
          Math.min(FETCH_TIMEOUT_MS, remaining)
        );
        if (!got) {
          attempts.push(`${url}: no file link found`);
          continue;
        }

        const check = validateEpub(got.buffer);
        if (!check.ok) {
          attempts.push(`${url}: ${check.reason}`);
          continue;
        }

        return { buffer: got.buffer, sourceUrl: got.url, bytes: got.buffer.length };
      } catch (err) {
        attempts.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return failed(md5, attempts);
}

function failed(md5: string, attempts: string[]): never {
  throw new Error(
    `Could not retrieve a valid EPUB for md5 ${md5}. Tried:\n` +
      attempts.map((a) => `  - ${a}`).join("\n")
  );
}
