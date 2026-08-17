import { config, fetchWithTimeout } from "../config";
import type {
  BookCandidate,
  LibgenEditionRecord,
  LibgenFileRecord,
  SearchResult,
} from "./types";

/**
 * libgen's json.php is a lookup, not a search — it takes ids you already hold.
 * The search page embeds those ids in the href of its "JSON" tab, covering the
 * entire result set rather than just the visible page. So the only HTML we
 * parse is that single attribute, which survives any restyling of the results
 * table.
 */
const JSON_LINK_RE = /json\.php\?[^"'\s>]*?ids=([\d,]+)/i;

/** Keep request URLs comfortably short; a broad query can match 1000+ files. */
const IDS_PER_REQUEST = 100;

/**
 * Upper bound on ids we resolve metadata for.
 *
 * A broad query ("dune frank herbert") returns 2000 ids — twenty sequential
 * json.php round trips before edition lookups even start, which would exceed
 * the function's time budget to produce a table of fifteen rows. We scan in
 * chunks and stop as soon as we have a deep enough pool to rank from.
 */
const MAX_IDS_SCANNED = 600;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetchWithTimeout(url, {
    headers: { Accept: "application/json,text/plain,*/*" },
  });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Expected JSON from ${url}, got ${text.slice(0, 120)}`);
  }
}

/** Fetch the search page and pull out the id list behind its JSON tab. */
async function fetchResultIds(mirror: string, query: string): Promise<string[]> {
  const url =
    `${mirror}/index.php?req=${encodeURIComponent(query)}` +
    // res=100 widens the HTML page, but the JSON tab already spans every page,
    // so this mainly reduces the chance of a paginated id list.
    `&res=100&covers=on&filesuns=all`;

  const res = await fetchWithTimeout(url);
  if (!res.ok) throw new Error(`Search page returned ${res.status}`);
  const html = await res.text();

  const match = html.match(JSON_LINK_RE);
  if (!match) {
    // Either zero results, or the JSON tab moved. Distinguish so the caller
    // can give the model a useful message instead of a generic failure.
    if (/not found|no results|nothing found/i.test(html)) return [];
    throw new Error(
      "Could not find the JSON id list on the search page. The mirror's " +
        "markup may have changed — check that the JSON tab still exists."
    );
  }
  return match[1].split(",").filter(Boolean);
}

/**
 * File records carry md5, extension, filesize, cover_exists and the shelf
 * locator, but no title or author — those live on the edition object.
 *
 * `fields=*` and `addkeys=*` were both tested against libgen.li and neither
 * joins edition data onto the file record, so the second object=e lookup is
 * mandatory rather than a fallback. Not worth re-requesting them here.
 */
async function fetchFileBatch(
  mirror: string,
  ids: string[]
): Promise<Record<string, LibgenFileRecord>> {
  return getJson<Record<string, LibgenFileRecord>>(
    `${mirror}/json.php?object=f&ids=${ids.join(",")}`
  );
}

/** Known-bad and hidden files, dropped before we spend a round trip on them. */
function isUsable(f: LibgenFileRecord): boolean {
  const broken = (f.broken || "").trim();
  const hidden = (f.visible || "").trim();
  return (broken === "" || broken === "0") && (hidden === "" || hidden === "0");
}

async function fetchEditionRecords(
  mirror: string,
  editionIds: string[]
): Promise<Record<string, LibgenEditionRecord>> {
  const merged: Record<string, LibgenEditionRecord> = {};
  for (const group of chunk(editionIds, IDS_PER_REQUEST)) {
    const url = `${mirror}/json.php?object=e&fields=*&ids=${group.join(",")}`;
    try {
      Object.assign(merged, await getJson<Record<string, LibgenEditionRecord>>(url));
    } catch {
      // Edition lookup is best-effort; locator parsing covers the gap.
      break;
    }
  }
  return merged;
}

/**
 * Recover title and author from the shelf path when edition metadata is
 * unavailable, e.g.
 *   "2011\2011-01-14\John Steinbeck - Of Mice and Men (v5.0) (epub).epub"
 */
export function parseLocator(locator: string): { title: string; author: string } {
  const base = (locator.split(/[\\/]/).pop() || locator)
    .replace(/(\.[a-z0-9]{2,4})+$/i, "")
    .replace(/\s*\((?:v[\d.]+|[a-z]+|[^)]{0,20})\)\s*/gi, " ")
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const dash = base.split(/\s+-\s+/);
  if (dash.length >= 2) {
    const [first, ...rest] = dash;
    const second = rest.join(" - ");
    // "Surname, Forename - Title" and "Forename Surname - Title" both put the
    // author first; a trailing "Title - Author" is rarer, so prefer the former.
    return { title: second.trim(), author: first.trim() };
  }
  return { title: base, author: "" };
}

function normalise(
  fileId: string,
  file: LibgenFileRecord,
  edition: LibgenEditionRecord | undefined,
  rank: number
): BookCandidate | null {
  if (!file.md5) return null;

  const fromLocator = file.locator ? parseLocator(file.locator) : { title: "", author: "" };
  const title =
    (file.title || (edition?.title as string) || fromLocator.title || "").trim() ||
    "(untitled)";
  const author =
    (file.author ||
      (edition?.author as string) ||
      (edition?.authors as string) ||
      fromLocator.author ||
      "").trim();

  return {
    md5: file.md5.toLowerCase(),
    fileId,
    title,
    author,
    year: (file.year || (edition?.year as string) || "").trim(),
    language: (file.language || (edition?.language as string) || "").trim(),
    publisher: (file.publisher || (edition?.publisher as string) || "").trim(),
    extension: (file.extension || "").toLowerCase(),
    filesize: Number.parseInt(file.filesize || "0", 10) || 0,
    hasCover: file.cover_exists === "1",
    pages: file.pages && file.pages !== "0" ? file.pages : "",
    rank,
  };
}

export interface SearchOptions {
  extension?: string;
  /** Candidates handed back to the model. Keep small — it has to read them. */
  limit?: number;
  /** Set internally by searchLibgen so ranking can score against the query. */
  query?: string;
}

const STOPWORDS = new Set(["a", "an", "the", "of", "and", "or", "in", "on", "to", "for"]);

function tokenise(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t));
}

/**
 * Score how well a candidate matches the query.
 *
 * libgen's own result order turned out not to be relevance-ranked — for "dune
 * frank herbert" it leads with Brian Herbert's sequels and a Gateway
 * collection, because every one of those also contains all three query tokens.
 * What separates the actual novel is that its title is *only* the query: no
 * extra words. So coverage alone is not enough, and title concision has to
 * carry real weight.
 */
function relevance(c: BookCandidate, queryTokens: string[]): number {
  if (queryTokens.length === 0) return 0;

  const titleTokens = tokenise(c.title);
  const haystack = new Set([...titleTokens, ...tokenise(c.author)]);

  const covered = queryTokens.filter((t) => haystack.has(t)).length;
  const coverage = covered / queryTokens.length;

  // Fraction of the title that is query terms. "Dune" scores 1.0;
  // "Sisterhood of Dune Brian Herbert & Kevin J Anderson" scores far lower.
  const inTitle = titleTokens.filter((t) => queryTokens.includes(t)).length;
  const concision = titleTokens.length > 0 ? inTitle / titleTokens.length : 0;

  return coverage * 2 + concision;
}

function filterAndRank(
  candidates: BookCandidate[],
  opts: SearchOptions
): BookCandidate[] {
  const ext = opts.extension?.toLowerCase();

  // Deliberately no language filter: verified against the live API, neither
  // the file nor the edition object exposes a language field, even though the
  // HTML results table displays one. A filter here would silently match
  // nothing. Language is left for the model to infer from title and filename.
  const kept = candidates.filter((c) => !ext || c.extension === ext);
  const queryTokens = tokenise(opts.query || "");

  // Ranking by filesize was measurably worse than this: it floated whichever
  // edition happened to be biggest, which for "dune frank herbert" meant
  // sequels and a Spanish translation above the novel. Size stays visible in
  // the table so the model can weigh it against the work, but it does not
  // drive the order. A cover is a cheap quality signal, used only to break
  // ties between equally relevant candidates.
  const scored = kept.map((c) => ({ c, score: relevance(c, queryTokens) }));

  return scored
    .sort((a, b) => {
      if (Math.abs(a.score - b.score) > 0.01) return b.score - a.score;
      if (a.c.hasCover !== b.c.hasCover) return a.c.hasCover ? -1 : 1;
      return a.c.rank - b.c.rank;
    })
    .map((s) => s.c);
}

export function formatBytes(bytes: number): string {
  if (!bytes) return "?";
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Markdown table the model picks from. md5 is the handle for download_book. */
export function toMarkdown(result: SearchResult): string {
  if (result.candidates.length === 0) {
    return `No matching files found (libgen matched ${result.totalMatched} files before filtering).`;
  }

  const esc = (s: string) => s.replace(/\|/g, "\\|");

  interface Column {
    header: string;
    value: (c: BookCandidate) => string;
    /** Always rendered, even when every row is blank. */
    required?: boolean;
  }

  // libgen's edition records are sparse — year, publisher and pages are blank
  // far more often than not. Emitting columns of dashes just burns the model's
  // attention, so only include a column something actually fills.
  const allColumns: Column[] = [
    { header: "Title", value: (c) => esc(c.title), required: true },
    { header: "Author", value: (c) => esc(c.author) },
    { header: "Year", value: (c) => c.year },
    { header: "Publisher", value: (c) => esc(c.publisher) },
    { header: "Pages", value: (c) => c.pages },
    { header: "Size", value: (c) => formatBytes(c.filesize) },
    { header: "Cover", value: (c) => (c.hasCover ? "yes" : "no") },
    { header: "md5", value: (c) => `\`${c.md5}\``, required: true },
  ];

  const columns = allColumns.filter(
    (col) => col.required || result.candidates.some((c) => col.value(c).trim() !== "")
  );

  const rows = result.candidates.map(
    (c) => `| ${columns.map((col) => col.value(c) || "—").join(" | ")} |`
  );

  const header =
    `| ${columns.map((c) => c.header).join(" | ")} |\n` +
    `| ${columns.map(() => "---").join(" | ")} |`;

  const notes: string[] = [
    result.truncated
      ? `${result.candidates.length} shown, ranked from the first ${result.scanned} of ${result.totalMatched} files matched on ${result.mirror}. Narrow the query if none of these fit.`
      : `${result.candidates.length} shown of ${result.totalMatched} files matched on ${result.mirror}.`,
    "Language is not exposed by libgen's API — infer it from the title and author.",
  ];
  if (result.degradedMetadata) {
    notes.push(
      "Edition metadata was unavailable; titles and authors were derived from filenames and may be rough."
    );
  }
  notes.push("Pass the md5 of your chosen row to download_book.");

  return `${header}\n${rows.join("\n")}\n\n${notes.join(" ")}`;
}

export async function searchLibgen(
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult> {
  const errors: string[] = [];

  const limit = opts.limit ?? 15;
  const ext = opts.extension?.toLowerCase();
  // Rank from a deeper pool than we display, but stop well short of resolving
  // every match — the extra depth buys nothing once ranking has enough to work
  // with, and each chunk is a sequential round trip against the clock.
  const targetPool = Math.max(limit * 3, 30);

  for (const mirror of config.mirrors()) {
    try {
      const ids = await fetchResultIds(mirror, query);
      if (ids.length === 0) {
        return {
          candidates: [],
          totalMatched: 0,
          scanned: 0,
          truncated: false,
          mirror,
          degradedMetadata: false,
        };
      }

      // json.php returns an object keyed by id, so the response gives no
      // ordering. Recover libgen's ranking from the position in the id list.
      const orderById = new Map(ids.map((id, i) => [id, i]));

      // Extension lives on the file record, so filtering here — before edition
      // lookups — is what keeps a 2000-result query affordable.
      const matched: [string, LibgenFileRecord][] = [];
      let scanned = 0;

      for (const group of chunk(ids, IDS_PER_REQUEST)) {
        const batch = await fetchFileBatch(mirror, group);
        scanned += group.length;

        for (const [fileId, f] of Object.entries(batch)) {
          if (!isUsable(f)) continue;
          if (ext && (f.extension || "").toLowerCase() !== ext) continue;
          matched.push([fileId, f]);
        }

        if (matched.length >= targetPool || scanned >= MAX_IDS_SCANNED) break;
      }

      const editionIds = new Set<string>();
      for (const [, f] of matched) {
        if (f.title) continue;
        for (const e of Object.values(f.editions || {})) {
          if (e?.e_id) editionIds.add(String(e.e_id));
        }
      }
      const editions =
        editionIds.size > 0 ? await fetchEditionRecords(mirror, [...editionIds]) : {};

      const candidates: BookCandidate[] = [];
      for (const [fileId, f] of matched) {
        const firstEditionId = Object.values(f.editions || {})[0]?.e_id;
        const edition = firstEditionId ? editions[String(firstEditionId)] : undefined;
        const c = normalise(fileId, f, edition, orderById.get(fileId) ?? Number.MAX_SAFE_INTEGER);
        if (c) candidates.push(c);
      }

      return {
        candidates: filterAndRank(candidates, { ...opts, query }).slice(0, limit),
        totalMatched: ids.length,
        scanned,
        truncated: scanned < ids.length,
        mirror,
        degradedMetadata: editionIds.size > 0 && Object.keys(editions).length === 0,
      };
    } catch (err) {
      errors.push(`${mirror}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error(`All mirrors failed.\n${errors.join("\n")}`);
}
