// Linking an EXISTING Google Drive file.
//
// STEWARD asks for the `drive.file` scope, which deliberately cannot see files
// STEWARD did not create. That is not a limitation to work around — it is the
// promise the connection makes. So linking an existing file means the operator
// hands that one file over, through Google's own Picker, and Drive grants
// per-file access to this app as a result.
//
// Loaded on demand: nothing here runs, and none of Google's JavaScript is
// fetched, until someone actually clicks "Link from Drive".

const PICKER_SDK = 'https://apis.google.com/js/api.js';

let sdkPromise = null;

/** Load Google's loader once, then the picker module inside it. */
function loadPickerSdk() {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = PICKER_SDK;
    s.async = true;
    s.onload = () => window.gapi.load('picker', { callback: resolve, onerror: reject });
    s.onerror = () => reject(new Error('could not load the Google Picker'));
    document.head.appendChild(s);
  }).catch((e) => { sdkPromise = null; throw e; });
  return sdkPromise;
}

/** Say what went wrong where the button is, rather than in a console nobody reads. */
function note(button, message, ok) {
  const form = button.closest('form') || button.parentElement;
  let s = form.querySelector('.form-status');
  if (!s) { s = document.createElement('p'); s.className = 'form-status'; form.appendChild(s); }
  s.textContent = message;
  s.dataset.ok = String(Boolean(ok));
}

export async function openPicker(button) {
  const entity = button.dataset.entity;
  const entityId = button.dataset.entityId;
  if (!entity || !entityId) return;

  const res = await fetch('/files/picker-config');
  const cfg = await res.json();
  if (!cfg.ready) {
    note(button, `Picker unavailable — missing ${(cfg.missing || ['configuration']).join(', ')}.`, false);
    return;
  }

  // Warn, then open anyway: an unrestricted key works fine on any port, and refusing to
  // try would be guessing at a Cloud Console setting the app cannot read.
  if (cfg.portNote) note(button, cfg.portNote, false);

  await loadPickerSdk();
  const { google } = window;

  // Everything the account can reach, including files shared with it — the
  // whole point is reaching what STEWARD itself cannot see.
  const view = new google.picker.DocsView(google.picker.ViewId.DOCS)
    .setIncludeFolders(true)
    .setSelectFolderEnabled(false);

  const picker = new google.picker.PickerBuilder()
    .setTitle('Link a Drive file to this record')
    .setDeveloperKey(cfg.apiKey)
    .setAppId(cfg.appId)
    .setOAuthToken(cfg.token)
    .addView(view)
    .enableFeature(google.picker.Feature.MULTISELECT_ENABLED)
    .setCallback(async (data) => {
      if (data[google.picker.Response.ACTION] !== google.picker.Action.PICKED) return;
      const files = (data[google.picker.Response.DOCUMENTS] || []).map((d) => ({
        name: d[google.picker.Document.NAME],
        url: d[google.picker.Document.URL],
        mimeType: d[google.picker.Document.MIME_TYPE],
        // Google Docs/Sheets report no size; a native upload does, as a string.
        size: Number(d.sizeBytes || 0),
      }));
      if (!files.length) return;

      const saved = await fetch('/files/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entity, entityId, files }),
      });
      if (!saved.ok) {
        note(button, `Could not link — error ${saved.status}.`, false);
        return;
      }
      // Show the new chips wherever this section is being read from.
      document.dispatchEvent(new CustomEvent('steward:refresh'));
    })
    .build();

  picker.setVisible(true);
}
