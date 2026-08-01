// Google Drive behind the DocumentStore port. Same three methods as the local
// store, so the rest of STEWARD never learns where bytes actually live.
//
// Files are created in a STEWARD folder in the operator's own Drive. With the
// `drive.file` scope we can only touch what we created — which is the point:
// connecting STEWARD does not hand it the rest of someone's Drive.

import type { DocumentStore, StoredFile } from '../docs/store.ts';
import type { GoogleAuth } from './oauth.ts';
import { DRIVE_FILES_API as FILES_API, ensureFolder, type Fetcher } from './folder.ts';

const UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3/files';

interface DriveFile {
  id?: string;
  size?: string;
  webViewLink?: string;
  error?: { message?: string };
}

export class GoogleDriveStore implements DocumentStore {
  readonly kind = 'drive' as const;
  private folderId: string | null = null;

  constructor(
    private auth: GoogleAuth,
    private folderName = 'STEWARD',
    private fetchImpl: Fetcher = fetch,
  ) {}

  private async token(): Promise<string> {
    const t = await this.auth.accessToken();
    if (!t) throw new Error('google drive is not connected');
    return t;
  }

  /** Find or create the STEWARD folder. Cached for the process lifetime. */
  private async folder(): Promise<string> {
    if (this.folderId) return this.folderId;
    this.folderId = await ensureFolder(await this.token(), this.folderName, this.fetchImpl);
    return this.folderId;
  }

  async put(name: string, bytes: Uint8Array, mimeType: string): Promise<StoredFile> {
    const token = await this.token();
    const parent = await this.folder();

    // Multipart upload: JSON metadata part, then the bytes.
    const boundary = `steward-${crypto.randomUUID()}`;
    const meta = JSON.stringify({ name, parents: [parent] });
    const head = new TextEncoder().encode(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n` +
      `--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`,
    );
    const tail = new TextEncoder().encode(`\r\n--${boundary}--`);
    const body = new Uint8Array(head.length + bytes.length + tail.length);
    body.set(head, 0);
    body.set(bytes, head.length);
    body.set(tail, head.length + bytes.length);

    const res = await this.fetchImpl(`${UPLOAD_API}?uploadType=multipart&fields=id,size,webViewLink`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: body as unknown as BodyInit,
    });
    const file = (await res.json()) as DriveFile;
    if (!res.ok || !file.id) {
      throw new Error(`drive upload failed: ${file.error?.message ?? res.status}`);
    }
    return {
      storageId: file.id,
      size: Number(file.size ?? bytes.byteLength),
      webViewLink: file.webViewLink ?? '',
    };
  }

  async get(storageId: string): Promise<Uint8Array | null> {
    const token = await this.token();
    const res = await this.fetchImpl(`${FILES_API}/${encodeURIComponent(storageId)}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`drive download failed: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  async remove(storageId: string): Promise<void> {
    const token = await this.token();
    const res = await this.fetchImpl(`${FILES_API}/${encodeURIComponent(storageId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    // Already gone is the desired state; anything else is a real failure.
    if (!res.ok && res.status !== 404) throw new Error(`drive delete failed: ${res.status}`);
  }
}
