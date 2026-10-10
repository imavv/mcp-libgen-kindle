import { Readable } from "node:stream";
import { google, type drive_v3 } from "googleapis";
import { config } from "../config";

/**
 * Google Drive as the handoff between download_book and send_to_kindle.
 *
 * These run as two separate Vercel invocations, potentially on different
 * instances, so /tmp cannot be relied on to carry the file between them.
 * Drive also gives the side benefit of a durable library you can re-send from
 * without hitting libgen again.
 *
 * Auth is OAuth2 with a stored refresh token rather than a service account:
 * service accounts have no Drive storage quota on personal (non-Workspace)
 * Google accounts, so they cannot own files in your My Drive.
 */

const FOLDER_MIME = "application/vnd.google-apps.folder";

let cachedFolderId: string | undefined;

function driveClient(): drive_v3.Drive {
  const auth = new google.auth.OAuth2(config.google.clientId(), config.google.clientSecret());
  auth.setCredentials({ refresh_token: config.google.refreshToken() });
  return google.drive({ version: "v3", auth });
}

/**
 * Locating the library folder.
 *
 * This used to be trivially safe: under drive.file alone the app could only
 * see folders it had created itself, so a name lookup could not collide with
 * anything else in the Drive. With drive.readonly added — so that books added
 * to the folder by hand are visible — a name lookup now searches the whole
 * Drive, and "Kindle Library" could match a folder this app never made.
 *
 * So the search is restricted to folders the user owns, and an ambiguous
 * result is a hard error rather than a coin flip: silently picking the wrong
 * folder would upload books somewhere unexpected. Setting
 * GOOGLE_DRIVE_FOLDER_ID skips all of this and is the recommended setup.
 */
async function ensureFolder(drive: drive_v3.Drive): Promise<string> {
  const configured = config.google.folderId();
  if (configured) return configured;
  if (cachedFolderId) return cachedFolderId;

  const name = config.google.folderName();
  const existing = await drive.files.list({
    q:
      `mimeType='${FOLDER_MIME}' and name='${name.replace(/'/g, "\\'")}' ` +
      `and trashed=false and 'me' in owners`,
    fields: "files(id,name)",
    orderBy: "createdTime",
    pageSize: 10,
  });

  const matches = existing.data.files || [];
  if (matches.length > 1) {
    throw new Error(
      `Found ${matches.length} folders named "${name}" in your Drive ` +
        `(${matches.map((f) => f.id).join(", ")}). Set GOOGLE_DRIVE_FOLDER_ID ` +
        `to the one you want so the server does not have to guess.`
    );
  }

  const found = matches[0]?.id;
  if (found) {
    cachedFolderId = found;
    return found;
  }

  const created = await drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME },
    fields: "id",
  });
  if (!created.data.id) throw new Error("Drive did not return an id for the new folder.");
  cachedFolderId = created.data.id;
  return cachedFolderId;
}

export interface StoredFile {
  fileId: string;
  filename: string;
  bytes: number;
  webViewLink?: string;
}

export async function uploadBook(
  buffer: Buffer,
  filename: string,
  mimeType: string
): Promise<StoredFile> {
  const drive = driveClient();
  const parent = await ensureFolder(drive);

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [parent], mimeType },
    media: { mimeType, body: Readable.from(buffer) },
    fields: "id,name,size,webViewLink",
  });

  if (!res.data.id) throw new Error("Drive upload succeeded but returned no file id.");
  return {
    fileId: res.data.id,
    filename: res.data.name || filename,
    bytes: Number.parseInt(res.data.size || "0", 10) || buffer.length,
    webViewLink: res.data.webViewLink || undefined,
  };
}

export async function downloadBook(
  fileId: string
): Promise<{ buffer: Buffer; filename: string }> {
  const drive = driveClient();

  const meta = await drive.files.get({ fileId, fields: "name,size" });
  const media = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );

  return {
    buffer: Buffer.from(media.data as ArrayBuffer),
    filename: meta.data.name || `${fileId}.epub`,
  };
}

export async function listLibrary(limit = 25): Promise<StoredFile[]> {
  const drive = driveClient();
  const parent = await ensureFolder(drive);

  // Books added to the folder by hand show up here too, so the listing can no
  // longer assume everything in it was uploaded by this app. Subfolders are
  // excluded because their ids are not something send_to_kindle can use.
  const res = await drive.files.list({
    q: `'${parent}' in parents and trashed=false and mimeType!='${FOLDER_MIME}'`,
    fields: "files(id,name,size,webViewLink)",
    orderBy: "createdTime desc",
    pageSize: limit,
  });

  return (res.data.files || []).map((f) => ({
    fileId: f.id!,
    filename: f.name || "(unnamed)",
    bytes: Number.parseInt(f.size || "0", 10) || 0,
    webViewLink: f.webViewLink || undefined,
  }));
}
