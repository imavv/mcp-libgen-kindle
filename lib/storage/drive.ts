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

const EPUB_MIME = "application/epub+zip";
const FOLDER_MIME = "application/vnd.google-apps.folder";

let cachedFolderId: string | undefined;

function driveClient(): drive_v3.Drive {
  const auth = new google.auth.OAuth2(config.google.clientId(), config.google.clientSecret());
  auth.setCredentials({ refresh_token: config.google.refreshToken() });
  return google.drive({ version: "v3", auth });
}

/**
 * With the drive.file scope we can only see files this app created, which is
 * exactly why looking up our own folder by name is safe here — there is no
 * risk of colliding with an unrelated folder in the user's Drive.
 */
async function ensureFolder(drive: drive_v3.Drive): Promise<string> {
  const configured = config.google.folderId();
  if (configured) return configured;
  if (cachedFolderId) return cachedFolderId;

  const name = config.google.folderName();
  const existing = await drive.files.list({
    q: `mimeType='${FOLDER_MIME}' and name='${name.replace(/'/g, "\\'")}' and trashed=false`,
    fields: "files(id,name)",
    pageSize: 1,
  });

  const found = existing.data.files?.[0]?.id;
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

export async function uploadEpub(
  buffer: Buffer,
  filename: string
): Promise<StoredFile> {
  const drive = driveClient();
  const parent = await ensureFolder(drive);

  const res = await drive.files.create({
    requestBody: { name: filename, parents: [parent], mimeType: EPUB_MIME },
    media: { mimeType: EPUB_MIME, body: Readable.from(buffer) },
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

export async function downloadEpub(
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

  const res = await drive.files.list({
    q: `'${parent}' in parents and trashed=false`,
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
