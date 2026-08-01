// Find-or-create the STEWARD folder in the operator's own Drive.
//
// Shared by the document store (which uploads into it) and the Sheets mirror
// (which moves its spreadsheet into it), because two copies of a find-or-create
// is how you end up with two folders.

export const DRIVE_FILES_API = 'https://www.googleapis.com/drive/v3/files';

export type Fetcher = typeof fetch;

/**
 * The folder's id, creating it if it isn't there.
 *
 * The search cannot collide with an unrelated folder the operator happens to have
 * named STEWARD: under `drive.file` we only ever see our own files.
 */
export async function ensureFolder(
  token: string,
  folderName: string,
  fetchImpl: Fetcher,
): Promise<string> {
  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false`,
  );
  const found = await fetchImpl(`${DRIVE_FILES_API}?q=${q}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await found.json()) as { files?: { id: string }[] };
  if (list.files?.length) return list.files[0].id;

  const made = await fetchImpl(DRIVE_FILES_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: folderName, mimeType: 'application/vnd.google-apps.folder' }),
  });
  const folder = (await made.json()) as { id?: string; error?: { message?: string } };
  if (!folder.id) {
    throw new Error(`could not create the Drive folder: ${folder.error?.message ?? 'unknown error'}`);
  }
  return folder.id;
}
