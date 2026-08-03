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
  parentId?: string,
): Promise<string> {
  // 0012 needs STEWARD/Archived, and a name search with no parent constraint would happily
  // find an unrelated `Archived` folder of the operator's — `drive.file` narrows what we can
  // see, it does not guarantee a name is ours.
  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${folderName}' and trashed=false` +
    (parentId ? ` and '${parentId}' in parents` : ''),
  );
  const found = await fetchImpl(`${DRIVE_FILES_API}?q=${q}&fields=files(id)`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const list = (await found.json()) as { files?: { id: string }[] };
  if (list.files?.length) return list.files[0].id;

  const made = await fetchImpl(DRIVE_FILES_API, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: folderName,
      mimeType: 'application/vnd.google-apps.folder',
      ...(parentId ? { parents: [parentId] } : {}),
    }),
  });
  const folder = (await made.json()) as { id?: string; error?: { message?: string } };
  if (!folder.id) {
    throw new Error(`could not create the Drive folder: ${folder.error?.message ?? 'unknown error'}`);
  }
  return folder.id;
}

/** The subfolder archived records' files are filed under (0012). */
export const ARCHIVED_FOLDER = 'Archived';

/**
 * Move files between the STEWARD folder and STEWARD/Archived.
 *
 * The same `addParents`/`removeParents` PATCH the Sheets mirror uses to file its own
 * spreadsheet. Returns how many actually moved; a file Google refuses is counted as not
 * moved rather than raised, because the caller has already stamped the database and a
 * half-moved set is re-runnable.
 */
export async function moveToFolder(
  token: string,
  fileIds: string[],
  from: string,
  to: string,
  fetchImpl: Fetcher,
): Promise<number> {
  let moved = 0;
  for (const id of fileIds) {
    const res = await fetchImpl(
      `${DRIVE_FILES_API}/${id}?addParents=${to}&removeParents=${from}&fields=id`,
      { method: 'PATCH', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}' },
    );
    if (res.ok) moved += 1;
  }
  return moved;
}
