import { config, fetchWithTimeout, FETCH_TIMEOUT_MS } from "../config";
import { validateEpub } from "../epub/validate";

/**
 * Download endpoints vary by mirror and by fork, and the exact one that works
 * moves around. Rather than encode a single guess, we try each shape, follow
 * one level of intermediate page, and accept whichever first yields bytes that
 * validate. Adding a new mirror shape later is a one-line change here.
 */
const DOWNLOAD_PATHS = [
  (mirror: string, md5: string) => `${mirror}/get.php?md5=${md5}`,
  (mirror: string, md5: string) => `${mirror}/ads.php?md5=${md5}`,
  (_m: string, md5: string) => `https://library.lol/fiction/${md5.toUpperCase()}`,
  (_m: string, md5: string) => `https://library.lol/main/${md5.toUpperCase()}`,
];

/** Hrefs on the intermediate page that actually point at the file. */
const DIRECT_LINK_RE =
  /href\s*=\s*["']([^"']*(?:get\.php\?[^"']*md5=|\/main\/|cdn\d?\.|download)[^"']*)["']/gi;

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
  const looksHtml = contentType.includes("text/html");

  if (!looksHtml) {
    const buffer = await readBody(res);
    return { buffer, url: res.url || url };
  }

  const html = await res.text();
  const seen = new Set<string>();
  for (const m of html.matchAll(DIRECT_LINK_RE)) {
    const target = absolutise(m[1], res.url || url);
    if (seen.has(target) || target === url) continue;
    seen.add(target);

    const inner = await fetchWithTimeout(
      target,
      { headers: { Referer: res.url || url }, redirect: "follow" },
      timeoutMs
    );
    if (!inner.ok) continue;
    if ((inner.headers.get("content-type") || "").includes("text/html")) continue;

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
