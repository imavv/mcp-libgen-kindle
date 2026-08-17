/**
 * Shapes returned by libgen's json.php.
 *
 * Everything is a string, including numbers and booleans — the API returns
 * "0"/"1"/"" rather than real JSON types. Fields are optional because the
 * exact set varies between mirrors and forks.
 */

export interface LibgenFileRecord {
  md5?: string;
  extension?: string;
  filesize?: string;
  /** "1" when a cover image exists. Maps to the "has cover" selection criterion. */
  cover_exists?: string;
  /** Non-empty means the file is known bad. Filter these out. */
  broken?: string;
  /** Empty means visible; non-empty means hidden/withdrawn. */
  visible?: string;
  /** Original path on the source shelf. Our fallback source of title/author. */
  locator?: string;
  time_added?: string;
  time_last_modified?: string;
  pages?: string;
  /** Keyed by an internal id; the useful value is the nested e_id. */
  editions?: Record<string, { e_id?: string } & Record<string, unknown>>;
  // Some mirrors join edition fields straight onto the file record when
  // fields=* is honoured, so these may or may not be present.
  title?: string;
  author?: string;
  year?: string;
  publisher?: string;
  language?: string;
}

export interface LibgenEditionRecord {
  title?: string;
  author?: string;
  authors?: string;
  year?: string;
  publisher?: string;
  language?: string;
  series?: string;
  [k: string]: unknown;
}

/** A file record joined with its edition metadata, normalised for display. */
export interface BookCandidate {
  md5: string;
  fileId: string;
  title: string;
  author: string;
  year: string;
  language: string;
  publisher: string;
  extension: string;
  /** Bytes. 0 when libgen did not report a size. */
  filesize: number;
  hasCover: boolean;
  pages: string;
  /** Position in libgen's own result ordering — its relevance signal. */
  rank: number;
}

export interface SearchResult {
  candidates: BookCandidate[];
  /** Total files libgen matched, before our filtering. */
  totalMatched: number;
  /** How many of those we actually resolved metadata for. */
  scanned: number;
  /** True when we stopped early rather than resolving every match. */
  truncated: boolean;
  mirror: string;
  /** True when edition metadata had to be recovered from the locator path. */
  degradedMetadata: boolean;
}
