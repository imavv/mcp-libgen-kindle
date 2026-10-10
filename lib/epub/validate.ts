/**
 * Cheap format validation with no parsing libraries.
 *
 * The point is not conformance checking — it is catching the common failure
 * where a mirror serves an HTML error page (or a login wall, or a rate-limit
 * notice) under a book's filename. Emailing one of those to Kindle fails
 * silently: Amazon drops it and you find out by picking up the device and
 * seeing nothing.
 *
 * Every supported format is identified by a magic number near the start of
 * the file, so a few hundred bytes is enough to tell a real book from an
 * error page without unpacking anything.
 */

export interface ValidationResult {
  ok: boolean;
  reason?: string;
  /** True for a valid zip that is not an EPUB (e.g. a .rar or .zip of images). */
  isZipButNotEpub?: boolean;
}

export interface FormatSpec {
  ext: string;
  mime: string;
  /**
   * Whether Amazon accepts this as a personal document. MOBI and AZW3 were
   * dropped from Send to Kindle in 2022 — they still download fine and are
   * worth keeping for other readers, but emailing one to a Kindle is a silent
   * no-op, so send_to_kindle refuses them rather than reporting a false send.
   */
  kindle: boolean;
  check(bytes: Buffer, head: string): ValidationResult;
}

/** Shared sanity checks: anything here means we did not get a book at all. */
function notABook(bytes: Buffer, head: string): ValidationResult | null {
  if (bytes.length < 100) {
    return { ok: false, reason: `File is only ${bytes.length} bytes — almost certainly an error page.` };
  }

  if (/^\s*(<!doctype html|<html|<\?xml[^>]*>\s*<!doctype html)/i.test(head)) {
    const title = head.match(/<title[^>]*>([^<]{0,120})/i)?.[1]?.trim();
    return {
      ok: false,
      reason: `Mirror returned an HTML page, not a file${title ? ` (page title: "${title}")` : ""}.`,
    };
  }

  // Naming the wrong-file case beats reporting raw bytes. A page asset getting
  // this far once cost a long debugging detour: "/*" is bootstrap.min.css.
  if (/^\s*\/\*/.test(head)) {
    return { ok: false, reason: "Got a CSS or JavaScript file, not a book — a page asset was followed instead of the download link." };
  }
  if (/^\s*(<\?xml|<!--)/.test(head)) {
    return { ok: false, reason: "Got an XML or markup document, not an ebook." };
  }

  return null;
}

/** Palm Database header, shared by MOBI and AZW3: "BOOKMOBI" at offset 60. */
function isPalmDoc(bytes: Buffer): boolean {
  return bytes.subarray(60, 68).toString("latin1") === "BOOKMOBI";
}

export const FORMATS: Record<string, FormatSpec> = {
  epub: {
    ext: "epub",
    mime: "application/epub+zip",
    kindle: true,
    check(bytes, head) {
      if (!(bytes[0] === 0x50 && bytes[1] === 0x4b)) {
        return {
          ok: false,
          reason: `Not a zip archive — expected "PK" signature, got bytes ${bytes[0]?.toString(16)} ${bytes[1]?.toString(16)}.`,
        };
      }
      // The EPUB spec requires the archive's first entry to be an uncompressed
      // "mimetype" file containing exactly "application/epub+zip", which puts
      // that literal string within the first ~60 bytes.
      if (!head.includes("application/epub+zip")) {
        return {
          ok: false,
          isZipButNotEpub: true,
          reason:
            "Valid zip archive but no EPUB mimetype entry at the start — this is probably a different format renamed to .epub.",
        };
      }
      return { ok: true };
    },
  },

  pdf: {
    ext: "pdf",
    mime: "application/pdf",
    kindle: true,
    check(bytes, head) {
      // %PDF- is required at the very start, though some files carry junk
      // bytes ahead of it, so allow a short preamble.
      if (!head.slice(0, 1024).includes("%PDF-")) {
        return { ok: false, reason: 'Not a PDF — no "%PDF-" signature near the start of the file.' };
      }
      return { ok: true };
    },
  },

  mobi: {
    ext: "mobi",
    mime: "application/x-mobipocket-ebook",
    kindle: false,
    check(bytes) {
      if (!isPalmDoc(bytes)) {
        return { ok: false, reason: 'Not a MOBI — no "BOOKMOBI" Palm Database header at offset 60.' };
      }
      return { ok: true };
    },
  },

  azw3: {
    ext: "azw3",
    mime: "application/vnd.amazon.ebook",
    kindle: false,
    check(bytes) {
      // AZW3 (KF8) is wrapped in the same Palm Database container as MOBI, so
      // the two cannot be told apart by magic number alone. Trust the
      // extension libgen reported for which one it is.
      if (!isPalmDoc(bytes)) {
        return { ok: false, reason: 'Not an AZW3 — no "BOOKMOBI" Palm Database header at offset 60.' };
      }
      return { ok: true };
    },
  },

  djvu: {
    ext: "djvu",
    mime: "image/vnd.djvu",
    kindle: false,
    check(bytes, head) {
      if (!head.startsWith("AT&TFORM")) {
        return { ok: false, reason: 'Not a DjVu — no "AT&TFORM" signature at the start of the file.' };
      }
      return { ok: true };
    },
  },
};

export const SUPPORTED_EXTENSIONS = Object.keys(FORMATS);

export function formatFor(extension: string): FormatSpec {
  const spec = FORMATS[extension.toLowerCase()];
  if (!spec) {
    throw new Error(
      `Unsupported format "${extension}". Supported: ${SUPPORTED_EXTENSIONS.join(", ")}.`
    );
  }
  return spec;
}

/** Infer the format from a stored filename, for the send path. */
export function formatForFilename(filename: string): FormatSpec | undefined {
  const ext = filename.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return ext ? FORMATS[ext] : undefined;
}

export function validateFile(
  buf: Buffer | Uint8Array,
  extension = "epub"
): ValidationResult {
  const bytes = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const head = bytes.subarray(0, 1024).toString("latin1");

  const broken = notABook(bytes, head);
  if (broken) return broken;

  return formatFor(extension).check(bytes, head);
}

/** Back-compat wrapper; the selftest and older call sites use this name. */
export function validateEpub(buf: Buffer | Uint8Array): ValidationResult {
  return validateFile(buf, "epub");
}

/**
 * Kindle uses the attachment filename as the on-device title, so this both
 * sanitises for the filesystem/mail transport and produces something readable
 * on the device. libgen filenames are frequently non-ASCII or malformed.
 */
export function buildFilename(title: string, author: string, extension = "epub"): string {
  const clean = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^\w\s'’,.-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const t = clean(title) || "Untitled";
  const a = clean(author);

  // 60 keeps the full filename at 65 chars, which is the most nodemailer will
  // put on one Content-Disposition line. Past that it switches to RFC 2231
  // continuations (filename*0/*1/*2), which Amazon's parser handles badly.
  // Cut back to a word boundary when truncating, since this string is what
  // shows up as the title on the device.
  const full = a ? `${t} - ${a}` : t;
  let stem = full;
  if (stem.length > 60) {
    stem = stem.slice(0, 60);
    const lastSpace = stem.lastIndexOf(" ");
    if (lastSpace > 30) stem = stem.slice(0, lastSpace);
  }
  stem = stem.replace(/[\s.-]+$/, "");
  return `${stem}.${extension.toLowerCase()}`;
}
