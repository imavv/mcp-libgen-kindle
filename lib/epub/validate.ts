/**
 * Cheap EPUB validation with no zip library.
 *
 * The point is not deep conformance checking — it is catching the common
 * failure where a mirror serves an HTML error page (or a login wall, or a
 * rate-limit notice) under a .epub filename. Emailing one of those to Kindle
 * fails silently: Amazon drops it and you find out by picking up the device
 * and seeing nothing.
 *
 * The EPUB spec requires the archive's first entry to be an uncompressed
 * "mimetype" file containing exactly "application/epub+zip", which puts that
 * literal string within the first ~60 bytes. So a PK signature plus that
 * string is a strong, dependency-free signal.
 */

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  /** True for a valid zip that is not an EPUB (e.g. a .rar or .zip of images). */
  isZipButNotEpub?: boolean;
}

export function validateEpub(buf: Buffer | Uint8Array): ValidationResult {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);

  if (bytes.length < 100) {
    return { ok: false, reason: `File is only ${bytes.length} bytes — almost certainly an error page.` };
  }

  const head = bytes.subarray(0, 512).toString("latin1");

  if (/^\s*(<!doctype html|<html|<\?xml[^>]*>\s*<!doctype html)/i.test(head)) {
    const title = head.match(/<title[^>]*>([^<]{0,120})/i)?.[1]?.trim();
    return {
      ok: false,
      reason: `Mirror returned an HTML page, not a file${title ? ` (page title: "${title}")` : ""}.`,
    };
  }

  if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
    return {
      ok: false,
      reason: `Not a zip archive — expected "PK" signature, got bytes ${bytes[0]?.toString(16)} ${bytes[1]?.toString(16)}.`,
    };
  }

  if (!head.includes("application/epub+zip")) {
    return {
      ok: false,
      isZipButNotEpub: true,
      reason:
        "Valid zip archive but no EPUB mimetype entry at the start — this is probably a different format renamed to .epub.",
    };
  }

  return { ok: true };
}

/**
 * Kindle uses the attachment filename as the on-device title, so this both
 * sanitises for the filesystem/mail transport and produces something readable
 * on the device. libgen filenames are frequently non-ASCII or malformed.
 */
export function buildFilename(title: string, author: string): string {
  const clean = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w\s'’,.-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const t = clean(title) || "Untitled";
  const a = clean(author);
  const stem = (a ? `${t} - ${a}` : t).slice(0, 150).replace(/[\s.-]+$/, "");
  return `${stem}.epub`;
}
