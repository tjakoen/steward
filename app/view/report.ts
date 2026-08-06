// The bug-report page, and the Settings card that explains it (0015).
//
// The page is arranged around one constraint: the body is going to a PUBLIC repository,
// under the operator's own name. An app that assembles a description of its internal
// state and publishes it on a click, without showing the text, is publishing on someone
// else's behalf without asking — and would be, whatever we redacted, because the point is
// not that we got the redaction right, it is that it was never our call to make.
//
// So the text sits in a textarea, editable, and TWO things follow from that:
//
//   * The URL is rebuilt from the textarea's current value at the moment of the click,
//     never from the server's original. A design where the box shows a full log and the
//     URL carries a trimmed one is a design where the operator reviewed a document that
//     was not published.
//   * The budget is a live number on the page, recomputed on every keystroke, so someone
//     pasting a long stack trace finds out here rather than at a 414.
//
// And it opens with an ANCHOR, not a spawn. `app/launch.ts` shells `cmd /c start "" <url>`
// on Windows, where `&` is a command separator — a URL with `?title=…&body=…` handed to
// that function would run `body=…` as a second command and open GitHub's form empty. No
// query string has ever been through that path, so the bug has never fired. Do not
// "simplify" this feature into it. An anchor is also never caught by a popup blocker,
// which `window.open` after an `await` routinely is.

import { esc } from './html.ts';
import { ISSUE_NEW, LABEL, TITLE_MAX, URL_BUDGET, kb } from '../report/body.ts';
import type { Report } from '../report/index.ts';

const REPO_URL = 'https://github.com/tjakoen/steward';

/** What the report is, in the two sentences somebody actually reads before clicking. */
const preamble = (): string =>
  `<p>This opens a new issue on <strong>github.com/tjakoen/steward</strong> in your own ` +
  `browser, under your own GitHub account. That repository is <strong>public</strong>: ` +
  `everything left in the box below is published on the internet, permanently.</p>` +
  `<p class="muted">The report carries the version, the platform, what is connected, how ` +
  `many records exist and the tail of the log. It does <strong>not</strong> carry the ` +
  `connected Google account, the spreadsheet link, any mail address or password, the ` +
  `folder your data is in, or the id of any record — and anything stored in this ` +
  `machine's settings is replaced with <span class="mono">&lt;redacted&gt;</span> before ` +
  `you see it. Read it anyway. You are the one publishing it.</p>`;

export function reportPage(report: Report): string {
  const over = report.bytes > report.budget;
  const dropped = report.dropped > 0
    ? `<p class="muted">The oldest ${report.dropped} log ${report.dropped === 1 ? 'line' : 'lines'} ` +
      `did not fit in the URL and ${report.dropped === 1 ? 'was' : 'were'} left out; the box says where ` +
      `the cut is.</p>`
    : '';
  const logWhere = report.log.path
    ? `<p class="muted">The whole log is at <span class="mono">${esc(report.log.path)}</span> on this ` +
      `machine. Drag it into the issue if it is asked for — GitHub takes file attachments, ` +
      `STEWARD cannot send them.</p>`
    : `<p class="muted">${esc(report.log.reason)}</p>`;

  return `<div class="page-head"><h1>Report a bug</h1>` +
    `<span class="sub">from ${esc(report.screen)}</span></div>` +

    `<section class="panel"><div class="panel__head"><h2>Before you send it</h2></div>` +
    `<div class="panel__body">${preamble()}</div></section>` +

    `<section class="panel"><div class="panel__head"><h2>The report</h2></div>` +
    `<div class="panel__body">` +
    `<label class="report-label" for="report-title">Title</label>` +
    `<input class="report-title" id="report-title" type="text" maxlength="${TITLE_MAX}" ` +
    `value="${esc(report.title)}" spellcheck="false">` +
    `<label class="report-label" for="report-body">Body — say what happened at the top, then ` +
    `read what is underneath and delete anything you would rather not publish</label>` +
    `<textarea class="report-box" id="report-body" rows="24" spellcheck="true">${esc(report.body)}</textarea>` +
    `<p class="report-size" id="report-size" data-over="${over}" role="status">` +
    `${esc(kb(report.bytes))} of ${esc(kb(report.budget))}</p>` +
    dropped +
    `<div class="form-controls">` +
    // target=_blank + rel=noopener: a new tab is the browser's job, and this page keeps
    // its state so Copy still works if GitHub is unreachable.
    `<a class="btn" data-variant="soft" id="report-open" target="_blank" rel="noopener" ` +
    `href="${esc(report.url)}">Open GitHub and file it ↗</a>` +
    `<button type="button" class="btn" id="report-copy">Copy</button>` +
    `<button type="button" class="btn" id="report-save">Save to a file</button>` +
    `</div>` +
    `<p class="form-status" id="report-status" hidden></p>` +
    `<p class="muted">No network? <strong>Copy</strong> and <strong>Save to a file</strong> both ` +
    `work on the text as you have edited it, with no size limit — paste or drag it into ` +
    `<a href="${REPO_URL}/issues" target="_blank" rel="noopener">the issue tracker</a> whenever ` +
    `you next have a connection.</p>` +
    logWhere +
    reportScript() +
    `</div></section>`;
}

/**
 * The whole client half. Rebuilds the URL from the CURRENT textarea value on every
 * keystroke, so what was reviewed is exactly what is sent.
 *
 * `encodeURIComponent` output is pure ASCII, so `.length` is the byte count — the same
 * number `urlBytes` computed on the server, from the same two strings.
 */
const reportScript = (): string => `<script type="module">
  const ISSUE = ${JSON.stringify(ISSUE_NEW)};
  const BUDGET = ${URL_BUDGET}, TITLE_MAX = ${TITLE_MAX};
  const title = document.getElementById('report-title');
  const body = document.getElementById('report-body');
  const open = document.getElementById('report-open');
  const size = document.getElementById('report-size');
  const status = document.getElementById('report-status');
  const say = (text, ok) => { status.hidden = false; status.textContent = text; status.dataset.ok = String(!!ok); };
  const kb = (n) => (n / 1000).toFixed(1) + ' KB';

  const build = () => ISSUE + '?title=' + encodeURIComponent(title.value.slice(0, TITLE_MAX))
    + '&body=' + encodeURIComponent(body.value) + '&labels=' + ${JSON.stringify(LABEL)};

  const sync = () => {
    const url = build();
    const over = url.length - BUDGET;
    size.textContent = kb(url.length) + ' of ' + kb(BUDGET)
      + (over > 0 ? ' — ' + over + ' bytes too many' : '');
    size.dataset.over = String(over > 0);
    open.setAttribute('aria-disabled', String(over > 0));
    // The href is always the real URL — over budget the CLICK is refused, because a '#'
    // href would still navigate and a disabled-looking link that works is worse than
    // either. What is in the box is what the link carries, always.
    open.href = url;
  };

  open.addEventListener('click', (e) => {
    if (open.getAttribute('aria-disabled') !== 'true') return;
    e.preventDefault();
    say('That is ' + (build().length - BUDGET) + ' bytes past what a URL carries — GitHub would refuse it. '
      + 'Shorten the body, or use Copy and paste it into a blank issue yourself.');
  });

  document.getElementById('report-copy').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(body.value); say('Copied — paste it into a new issue.', true); }
    catch { body.select(); say('Could not reach the clipboard. The text is selected; copy it by hand.'); }
  });

  document.getElementById('report-save').addEventListener('click', () => {
    const blob = new Blob([body.value], { type: 'text/markdown' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'steward-bug-report.md';
    a.click();
    URL.revokeObjectURL(a.href);
    say('Saved to steward-bug-report.md. Drag it into the issue.', true);
  });

  title.addEventListener('input', sync);
  body.addEventListener('input', sync);
  sync();

  // The cursor lands under the first prompt, because that sentence is the part of this
  // report nobody else can write.
  const at = body.value.indexOf('\\n\\n');
  body.focus();
  if (at >= 0) body.setSelectionRange(at + 2, at + 2);
</script>`;

/**
 * The Settings card. Settings is where Google, Sheets, the digest, the version and the
 * log file path are already stated, and a support card belongs in that company — but a
 * card reachable only from Settings always answers "the screen was /settings", which is
 * worthless. Hence the nav item too, on every page, carrying `?from=`.
 */
export function reportCard(logPath: string | null): string {
  return `<section class="panel"><div class="panel__head"><h2>Report a bug</h2></div>` +
    `<div class="panel__body">` +
    `<p>Something broken? <a href="/report?from=/settings">Write a bug report</a> — or use ` +
    `<strong>Report a bug</strong> at the foot of the sidebar, from whichever screen went wrong.</p>` +
    `<p class="muted">It collects the version, the platform, what is connected, how many records ` +
    `exist and the tail of the log, and shows you the exact text before anything is sent. ` +
    `The connected Google account, the spreadsheet link, every mail setting and every stored ` +
    `password are left out.</p>` +
    `<p class="muted">Issues are filed on ` +
    `<a href="${REPO_URL}/issues" target="_blank" rel="noopener">github.com/tjakoen/steward</a>, ` +
    `which is public, from your own browser and your own GitHub account.</p>` +
    (logPath
      ? `<p class="muted">The full log is at <span class="mono">${esc(logPath)}</span>, if one is ` +
        `asked for.</p>`
      : '') +
    `</div></section>`;
}
