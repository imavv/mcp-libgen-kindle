import { searchLibgen } from "@/lib/libgen/search";
import { downloadByMd5 } from "@/lib/libgen/download";
import { validateEpub } from "@/lib/epub/validate";

/**
 * Deployment smoke test. Hit this first, before trusting anything else.
 *
 * The open question this answers: whether libgen mirrors serve Vercel at all.
 * Vercel egresses from AWS ranges, and Cloudflare-fronted mirrors treat
 * datacenter IPs more aggressively than residential ones. It works from your
 * laptop; that tells you nothing about whether it works from a function.
 *
 *   curl -H "Authorization: Bearer $MCP_AUTH_TOKEN" \
 *        "https://<your-deployment>/selftest?q=of+mice+and+men"
 */
/** 60 is the Hobby ceiling; exceeding the plan limit fails the deployment. */
export const maxDuration = 60;

/**
 * This route is the only place that runs search and download in one
 * invocation, so it has to budget across both. Vercel kills an over-running
 * function with no response body at all, which is the least useful possible
 * outcome for a diagnostic endpoint — better to stop early and report what
 * we learned.
 */
const OVERALL_BUDGET_MS = 45_000;
const MIN_DOWNLOAD_MS = 8_000;

export async function GET(req: Request) {
  // Distinguish "server has no token" from "caller sent the wrong one". Both
  // returning 401 makes a missing Vercel env var look identical to a typo,
  // which is the difference between redeploying and re-copying a value.
  const expected = process.env.MCP_AUTH_TOKEN;
  if (!expected) {
    return new Response(
      "MCP_AUTH_TOKEN is not set on the server. Add it in the Vercel project's " +
        "environment variables, then redeploy — existing deployments do not pick " +
        "up variables added after they were built.",
      { status: 503 }
    );
  }

  const header = req.headers.get("authorization");
  if (!header) {
    return new Response("Missing Authorization header.", { status: 401 });
  }

  const provided = header.replace(/^Bearer\s+/i, "").trim();
  if (provided !== expected) {
    return new Response(
      `Token mismatch. Server expects a ${expected.length}-character token; ` +
        `received ${provided.length} characters.`,
      { status: 401 }
    );
  }

  const url = new URL(req.url);
  const query = url.searchParams.get("q") || "of mice and men steinbeck";
  const skipDownload = url.searchParams.get("download") === "0";

  const steps: Record<string, unknown> = {};
  const started = Date.now();

  try {
    const t0 = Date.now();
    const result = await searchLibgen(query, { extension: "epub", limit: 5 });
    steps.search = {
      ok: true,
      ms: Date.now() - t0,
      mirror: result.mirror,
      totalMatched: result.totalMatched,
      epubCandidates: result.candidates.length,
      degradedMetadata: result.degradedMetadata,
      // Whether edition metadata came through decides two-call vs three-call.
      sample: result.candidates.slice(0, 3).map((c) => ({
        title: c.title,
        author: c.author,
        language: c.language,
        bytes: c.filesize,
        hasCover: c.hasCover,
        md5: c.md5,
      })),
    };

    if (skipDownload || result.candidates.length === 0) {
      return Response.json({ ok: true, totalMs: Date.now() - started, steps });
    }

    const budgetLeft = OVERALL_BUDGET_MS - (Date.now() - started);
    if (budgetLeft < MIN_DOWNLOAD_MS) {
      steps.download = {
        ok: false,
        skipped: true,
        reason: `Search used ${Date.now() - started}ms of a ${OVERALL_BUDGET_MS}ms budget, leaving too little to attempt a download. Search itself works — retry with &download=0 to confirm, and treat the search latency as the problem.`,
      };
      return Response.json({ ok: false, totalMs: Date.now() - started, steps }, { status: 504 });
    }

    const t1 = Date.now();
    const target = result.candidates[0];
    const dl = await downloadByMd5(target.md5, budgetLeft);
    const check = validateEpub(dl.buffer);
    steps.download = {
      ok: check.ok,
      ms: Date.now() - t1,
      md5: target.md5,
      bytes: dl.bytes,
      sourceUrl: dl.sourceUrl,
      validation: check,
    };

    return Response.json({ ok: true, totalMs: Date.now() - started, steps });
  } catch (err) {
    steps.error = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, totalMs: Date.now() - started, steps }, { status: 502 });
  }
}
