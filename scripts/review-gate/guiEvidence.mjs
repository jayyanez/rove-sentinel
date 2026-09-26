// GUI evidence gate (docs/design/visual-redesign-plan.md §5.1, §4.7).
//
// Until `/design-review` captures its own screenshots, a GUI diff must COMMIT
// its evidence: at least one screenshot under docs/design/reviews/<slug>/ and,
// for every new control, a placement row in docs/design/control-registry.md.
// Pure: it looks at the changed-file list, the committed patch and the HEAD
// registry text only — no network, no PR, no working tree — so it holds
// offline and on the first push of a new branch. Both rules are checked
// against the files CHANGED IN THE DIFF (base...head), so the evidence is
// produced for this branch rather than inherited from an ancestor's folder.
//
// Rules the second review of V1 added:
// - a DELETED screenshot is not evidence (a `changedFiles` entry may carry a
//   git status; `D` never counts, `A`/`M`/`R`/`C` do);
// - a new control needs an actual ROW in the registry as committed at head,
//   not merely a touched registry file;
// - `data-control={expression}` is refused outright: the registry can only
//   be checked against a string literal;
// - "new" is decided PER FILE: an id added in a file where it did not exist
//   at base is new, even when the same id was removed from another file;
// - a tag push is NOT skipped: git never requires a tagged commit to have
//   been pushed through a branch, so the tag's own base...head diff must carry
//   evidence. A tag has no branch slug, so a PNG under ANY
//   docs/design/reviews/<slug>/ folder in the diff counts; the registry rule
//   applies unchanged;
// - an evidence PNG must BE a PNG as committed at head (8-byte signature and
//   more than the signature), checked through the injected `readBlob(path)`;
//   a text file renamed `.png` is refused with its path.
//
// Rules the third review of V1 added:
// - `src/app.html` is a GUI file: it carries the first-paint palette and the
//   theme attributes the mode-derived tokens key on;
// - a GUI diff needs the branch's `docs/design/reviews/<slug>/REVIEW.md`
//   (the checklist, findings and deviations), not only PNGs; for a tag, a
//   REVIEW.md next to any counted PNG's folder, PRESENT AT HEAD through the
//   injected `hasFile(path)` (prepush: the blob at head), or — when no reader
//   is given — as a non-deleted entry of the changed-file list;
// - a control id added in a file where it did not exist at base (new, or
//   MOVED from another surface) needs its OWN row of
//   `docs/design/control-registry.md` among the diff's added/removed lines,
//   as well as a row at head: a move is a placement decision, and a stale row
//   that still names the old surface must not pass because an unrelated row
//   changed in the same file.
//
// Rules the fourth review of V1 added:
// - an evidence PNG is validated structurally (IHDR first, chunk walk inside
//   the file, IEND last), not by signature alone;
// - on a tag, EVERY reviews folder that contributed a counted PNG must carry
//   its REVIEW.md at head, not just one of them.
//
// Rules the fifth review of V1 added:
// - an evidence PNG must carry at least one non-empty IDAT chunk: a
//   header-only file (IHDR + IEND) is structurally complete and still no image;
// - for a BRANCH push the REVIEW.md must be ADDED OR MODIFIED (not deleted) in
//   the base...head diff itself, not merely present at head: the evidence and
//   its review are produced for this branch, so a review inherited unchanged
//   from an ancestor commit does not cover new screenshots. A tag keeps the
//   present-at-head rule (it has no branch of its own to review on).
//
// Rules the sixth review of V1 added:
// - the IDAT payload must DECODE: every IDAT chunk is concatenated and
//   inflated (bounded) and, for a non-interlaced image, the raw size must be
//   exactly what IHDR implies — valid framing around garbage or a truncated
//   deflate stream is not a screenshot;
// - tag vs branch is decided by the pushed ref's TYPE (`refs/tags/…` vs
//   `refs/heads/…`), passed in as `refType`, never by the ref's name: a branch
//   literally named `tag/release` follows the branch rule.

import { inflateSync } from 'node:zlib';

import { branchEvidenceSlug } from './evidenceSlug.mjs';

const GUI_FILE = [
  /\.svelte$/i,
  /\.css$/i,
  /^src\/lib\/theme\//,
  /^src\/lib\/components\/shared\/Icon\.svelte$/,
  // Component-adjacent TS: positioning, keyboard contracts, actions the
  // markup delegates to (`shared/popoverPosition.ts`, `modalKeydown.ts`).
  // A change there moves pixels or changes what a key does as surely as the
  // .svelte file would.
  /^src\/lib\/components\/.+\.ts$/,
  // Stories and routes are GUI surfaces too (`src/routes/dev/components`).
  /^src\/routes\/.+\.(?:svelte|ts)$/,
  // First-paint palette + the data-theme / data-theme-mode stamps app.css keys on.
  /^src\/app\.html$/,
];
// Tests under a governed folder are text ABOUT the GUI, not the GUI.
const TEST_FILE = /(?:^|\/)__tests__\/|\.test\.[cm]?[jt]s$/;

const DOC_ONLY = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;
export const CONTROL_REGISTRY = 'docs/design/control-registry.md';
const REVIEW_PNG = /^docs\/design\/reviews\/([^/]+)\/.+\.png$/i;
export const REVIEW_DOC = 'REVIEW.md';

/** `docs/design/reviews/<slug>/REVIEW.md` — the review document for one evidence folder. */
export function reviewDocPath(slug) {
  return `docs/design/reviews/${slug}/${REVIEW_DOC}`;
}
// The 8-byte signature every real PNG file starts with.
export const PNG_SIGNATURE = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const DATA_CONTROL = /data-control\s*=\s*["']([^"']+)["']/g;
// Any `data-control=` whose value is not a quoted string: `{expr}`, a bare
// word, a template literal, …
const DATA_CONTROL_EXPRESSION = /data-control\s*=\s*(?!["'])(\S+)/g;
// The one allowed expression: a shared primitive forwarding its `dataControl`
// prop to its root element. The literal lives at the call site
// (`<IconButton data-control="pane.close" />`), which is where the registry
// check reads it; the primitive itself never names a control.
const PRIMITIVE_DIR = /^src\/lib\/components\/shared\//;
const FORWARDED_PROP = '{dataControl}';

export function isForwardedControlProp(file, value) {
  return PRIMITIVE_DIR.test(String(file || '')) && String(value || '').startsWith(FORWARDED_PROP);
}
// Only component sources name controls; a `data-control="…"` in a test
// fixture, a script or a doc is text about controls, not a control. Bare
// hunks without file headers (tests) are scanned as if they were components.
const CONTROL_SOURCE = /^src\/lib\/components\/.+\.svelte$/;

function isControlSource(file) {
  return file === '' || CONTROL_SOURCE.test(file);
}

export const CAPTURE_COMMAND = 'pnpm design:capture';

// Re-exported so the gate, prepush and the tests keep one import site; the
// rule itself lives with the capture that writes the folder.
export { branchEvidenceSlug };

/**
 * The kind of ref being checked, as the push-ref parser saw it:
 * `refs/tags/…` is `'tag'`, `refs/heads/…` (and anything else) is `'branch'`.
 * Decided by ref TYPE only — a branch named `tag/release` is a branch — and
 * anything that is not exactly `'tag'` takes the stricter branch rule.
 */
export function isTagRefType(refType) {
  return refType === 'tag';
}

/**
 * `changedFiles` entries are either plain paths (assumed added/modified — the
 * shape older callers and tests pass) or `{ path, status }` from
 * `git diff --name-status` (`A`, `M`, `D`, `R`, `C`, `T`, …).
 */
export function normalizeChangedFiles(files) {
  const list = Array.isArray(files) ? files : [];
  const out = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      if (entry) out.push({ path: entry, status: 'A' });
    } else if (entry && typeof entry.path === 'string' && entry.path) {
      out.push({ path: entry.path, status: String(entry.status || 'A').toUpperCase().charAt(0) || 'A' });
    }
  }
  return out;
}

function isPresentAtHead(entry) {
  return entry.status !== 'D';
}

const PNG_CHUNK_OVERHEAD = 12; // 4 length + 4 type + 4 CRC
const PNG_IHDR_LENGTH = 13;
// Upper bound on the inflated pixel stream; anything larger is not an
// evidence screenshot (a 4K RGBA capture is ~33 MiB). Bounds the decode too.
const PNG_MAX_RAW_BYTES = 64 * 1024 * 1024;
// Samples per pixel by IHDR colour type (0 grey, 2 RGB, 3 palette, 4 grey+A, 6 RGBA).
const PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const PNG_BIT_DEPTHS = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/**
 * Raw (filtered, uncompressed) byte count a non-interlaced image of this IHDR
 * decodes to: height × (1 filter byte + ceil(width × bits per pixel / 8)).
 * `null` for an IHDR whose colour type / bit depth pair the spec does not
 * allow, or when the raw size would exceed the evidence bound.
 */
function expectedRawSize({ width, height, bitDepth, colorType }) {
  const channels = PNG_CHANNELS[colorType];
  if (!channels || !PNG_BIT_DEPTHS[colorType].includes(bitDepth)) return null;
  const rowBytes = 1 + Math.ceil((width * channels * bitDepth) / 8);
  const total = rowBytes * height;
  return Number.isSafeInteger(total) && total <= PNG_MAX_RAW_BYTES ? total : null;
}

/**
 * Inflate the concatenated IDAT payload: the stream must inflate to EXACTLY
 * the raw size IHDR implies (`maxOutputLength` bounds the decode at that size,
 * so an over-long stream fails inside zlib). Interlaced (Adam7) images are
 * refused outright: no screenshot tool Rove uses (Playwright/Chromium) writes
 * them, and validating seven pass geometries buys nothing for evidence.
 */
function idatDecodes(idat, header) {
  try {
    if (header.interlace !== 0) return false;
    const expected = expectedRawSize(header);
    if (expected === null) return false;
    return inflateSync(idat, { maxOutputLength: expected }).length === expected;
  } catch {
    return false;
  }
}

function chunkType(blob, offset) {
  return String.fromCharCode(blob[offset], blob[offset + 1], blob[offset + 2], blob[offset + 3]);
}

function readUint32(blob, offset) {
  return ((blob[offset] << 24) >>> 0) + (blob[offset + 1] << 16) + (blob[offset + 2] << 8) + blob[offset + 3];
}

/**
 * True when `blob` (Buffer / Uint8Array) is a complete PNG whose image data
 * decodes: the 8-byte signature, an `IHDR` first chunk (13 bytes, width and
 * height > 0), a chunk walk (length + type + data + CRC) that stays inside the
 * file, at least one NON-EMPTY `IDAT` chunk, `IEND` as the last chunk, and an
 * IDAT stream (all chunks concatenated) that inflates to exactly the raw size
 * IHDR implies; interlaced (Adam7) files are refused. A signature with garbage behind it, a file cut mid-chunk,
 * one that never reaches IEND, a header-only file, valid framing around bytes
 * that are not a deflate stream, or a truncated stream is not a screenshot.
 * CRCs are not verified and filters are not undone: this is a "did the
 * capture write a whole image" check, not a renderer. Synchronous and pure
 * (zlib only; no I/O).
 */
export function isPngBlob(blob) {
  if (!(blob instanceof Uint8Array)) return false;
  if (blob.length <= PNG_SIGNATURE.length) return false;
  for (let index = 0; index < PNG_SIGNATURE.length; index += 1) {
    if (blob[index] !== PNG_SIGNATURE[index]) return false;
  }
  let offset = PNG_SIGNATURE.length;
  let header = null;
  let sawEnd = false;
  const idatChunks = [];
  while (offset < blob.length) {
    if (offset + PNG_CHUNK_OVERHEAD > blob.length) return false;
    const length = readUint32(blob, offset);
    const type = chunkType(blob, offset + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return false;
    const dataStart = offset + 8;
    const next = dataStart + length + 4;
    if (next > blob.length) return false;
    if (header === null) {
      if (type !== 'IHDR' || length !== PNG_IHDR_LENGTH) return false;
      header = {
        width: readUint32(blob, dataStart),
        height: readUint32(blob, dataStart + 4),
        bitDepth: blob[dataStart + 8],
        colorType: blob[dataStart + 9],
        interlace: blob[dataStart + 12],
      };
      if (header.width === 0 || header.height === 0) return false;
    } else if (type === 'IEND') {
      if (length !== 0) return false;
      sawEnd = true;
      offset = next;
      break;
    } else if (type === 'IDAT' && length > 0) {
      idatChunks.push(blob.subarray(dataStart, dataStart + length));
    }
    offset = next;
  }
  if (!sawEnd || !idatChunks.length || offset !== blob.length) return false;
  return idatDecodes(Buffer.concat(idatChunks), header);
}

/**
 * The screenshots this diff offers as evidence: present at head, under the
 * branch's own folder — or under any reviews folder for a tag ref (`refType`
 * `'tag'`), which has no branch slug. Prepush reads these blobs at head
 * before deciding.
 */
export function evidenceScreenshotPaths(files, branch, refType = 'branch') {
  const slug = isTagRefType(refType) ? null : branchEvidenceSlug(branch);
  return normalizeChangedFiles(files)
    .filter((entry) => isPresentAtHead(entry) && REVIEW_PNG.test(entry.path))
    .filter((entry) => slug === null || REVIEW_PNG.exec(entry.path)[1] === slug)
    .map((entry) => entry.path);
}

export function isGuiDiff(files) {
  return normalizeChangedFiles(files).some(
    ({ path }) => !DOC_ONLY.test(path) && !TEST_FILE.test(path) && GUI_FILE.some((pattern) => pattern.test(path)),
  );
}

/**
 * Ids from the registry's table rows — the same shape
 * `src/lib/theme/__tests__/controlRegistry.test.ts` parses: seven cells, the
 * first a backticked id. Header/separator rows and the column legend are
 * skipped because their first cell is not backticked or has other widths.
 */
export function registryControlIds(markdown) {
  const ids = new Set();
  for (const raw of String(markdown || '').split(/\r?\n/)) {
    const id = registryRowId(raw);
    if (id) ids.add(id);
  }
  return ids;
}

/** The backticked id of one registry table row, or null. */
function registryRowId(line) {
  const match = /^\|\s*`([^`]+)`\s*\|(.*)\|\s*$/.exec(String(line || '').trim());
  if (!match || match[2].split('|').length !== 6) return null;
  return match[1];
}

/**
 * Ids whose registry ROW is added or removed by the patch (a `+` or `-` line
 * of docs/design/control-registry.md whose first cell is that id). An edit
 * elsewhere in the registry does not count for a control it does not name.
 */
export function changedRegistryRowIds(patch) {
  const ids = new Set();
  for (const { file, lines } of patchFileSections(patch)) {
    if (file !== CONTROL_REGISTRY) continue;
    for (const line of lines) {
      if (!line.startsWith('+') && !line.startsWith('-')) continue;
      const id = registryRowId(line.slice(1));
      if (id) ids.add(id);
    }
  }
  return ids;
}

/**
 * Split a unified diff into `{ file, lines }` sections keyed by the post-image
 * path (`+++ b/<path>`, or the `diff --git` header for a pure deletion).
 */
export function patchFileSections(patch) {
  const sections = [];
  let current = null;
  // `+++ ` names the post-image only directly after its `--- ` line, before
  // any hunk; anywhere else it is an added line that happens to start "++".
  let afterMinusHeader = false;
  for (const line of String(patch || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      // `diff --git a/<old> b/<new>` — take the b/ side.
      const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
      current = { file: header ? header[2] : line.slice('diff --git '.length), lines: [] };
      sections.push(current);
      afterMinusHeader = false;
      continue;
    }
    if (afterMinusHeader && line.startsWith('+++ ')) {
      afterMinusHeader = false;
      const target = line.slice(4).trim();
      if (current && target !== '/dev/null') current.file = target.replace(/^b\//, '');
      continue;
    }
    afterMinusHeader = line.startsWith('--- ') && current !== null && !current.lines.some((l) => l.startsWith('@@'));
    if (afterMinusHeader) continue;
    if (!current) {
      // A patch without headers (tests pass bare hunks): one anonymous section.
      current = { file: '', lines: [] };
      sections.push(current);
    }
    current.lines.push(line);
  }
  return sections;
}

/**
 * Control ids introduced by the patch: `data-control="…"` on ADDED lines, in a
 * file where the id did not exist at base. Existing at base means the same
 * id appears on a removed or context line of the SAME file — an in-file move
 * or edit. An id removed from one file and added to another is new in the
 * second file (a move between surfaces is a placement decision too).
 */
export function addedControlIds(patch) {
  const added = new Set();
  for (const { file, lines } of patchFileSections(patch)) {
    if (!isControlSource(file)) continue;
    const inFileAdded = new Set();
    const atBase = new Set();
    for (const line of lines) {
      const isAdded = line.startsWith('+');
      const isRemoved = line.startsWith('-');
      const isContext = line.startsWith(' ');
      if (!isAdded && !isRemoved && !isContext) continue;
      for (const match of line.matchAll(DATA_CONTROL)) {
        (isAdded ? inFileAdded : atBase).add(match[1]);
      }
    }
    for (const id of inFileAdded) if (!atBase.has(id)) added.add(id);
  }
  return [...added].sort();
}

/**
 * Control ids the patch REMOVES from a component source (on `-` lines of a
 * file where no `+` or context line keeps them). Together with
 * `addedControlIds` this tells a move between surfaces apart from a brand-new
 * control — both need a registry update, the message just names the right one.
 */
export function removedControlIds(patch) {
  const removed = new Set();
  for (const { file, lines } of patchFileSections(patch)) {
    if (!isControlSource(file)) continue;
    const gone = new Set();
    const kept = new Set();
    for (const line of lines) {
      const isAdded = line.startsWith('+');
      const isRemoved = line.startsWith('-');
      const isContext = line.startsWith(' ');
      if (!isAdded && !isRemoved && !isContext) continue;
      for (const match of line.matchAll(DATA_CONTROL)) {
        (isRemoved ? gone : kept).add(match[1]);
      }
    }
    for (const id of gone) if (!kept.has(id)) removed.add(id);
  }
  return [...removed].sort();
}

/**
 * `data-control={…}` (or any other non-literal value) on ADDED lines, with the
 * file it lives in. The registry can only be checked against a literal; the
 * single exception is a shared primitive forwarding `{dataControl}`.
 */
export function expressionControlAttributes(patch) {
  const found = [];
  for (const { file, lines } of patchFileSections(patch)) {
    if (!isControlSource(file)) continue;
    for (const line of lines) {
      if (!line.startsWith('+')) continue;
      for (const match of line.matchAll(DATA_CONTROL_EXPRESSION)) {
        if (isForwardedControlProp(file, match[1])) continue;
        found.push({ file, value: match[1] });
      }
    }
  }
  return found;
}

/**
 * Human-readable problems; an empty array means the GUI diff carries its
 * evidence (or is not a GUI diff at all). `patch` is the base...head diff text
 * — raw `git diff` output (file headers included, so per-file decisions work).
 * `registry` is docs/design/control-registry.md AS COMMITTED AT HEAD (empty
 * when the file does not exist there). `readBlob(path)` returns the bytes of
 * an evidence file AS COMMITTED AT HEAD (Buffer / Uint8Array; `null` or
 * `undefined` when unreadable) so a screenshot is checked to be a real PNG;
 * a caller that passes no reader gets no byte check. `pngValid(path)` is the
 * bounded alternative (a verdict per screenshot, computed one blob at a time
 * by the caller) and takes precedence over `readBlob`. `refType` is `'tag'` for
 * a `refs/tags/…` push and `'branch'` (the default) otherwise — the ref's
 * type as parsed, never inferred from `branch`'s name.
 */
export function guiEvidenceProblems({ files, branch, refType = 'branch', patch = '', registry = '', readBlob, pngValid, hasFile }) {
  const list = normalizeChangedFiles(files);
  if (!isGuiDiff(list)) return [];
  const problems = [];
  const tag = isTagRefType(refType);
  const slug = tag ? null : branchEvidenceSlug(branch);
  const expectedFolder = tag ? 'docs/design/reviews/<slug>/' : `docs/design/reviews/${slug}/`;
  const pngs = list.filter((entry) => REVIEW_PNG.test(entry.path));
  const inFolder = (entry) => tag || REVIEW_PNG.exec(entry.path)[1] === slug;
  const notPng = [];
  const screenshots = [];
  for (const entry of pngs.filter((candidate) => isPresentAtHead(candidate) && inFolder(candidate))) {
    // `pngValid(path)` is the bounded form: the caller checked each blob one
    // at a time and kept only the verdict; `readBlob` is the byte form.
    const ok = typeof pngValid === 'function'
      ? pngValid(entry.path) === true
      : typeof readBlob !== 'function' || isPngBlob(readBlob(entry.path));
    if (!ok) notPng.push(entry.path);
    else screenshots.push(entry);
  }
  // The review document. A branch: added or modified IN THIS DIFF (a
  // non-deleted entry of the changed-file list), because the review is
  // produced for this branch's evidence — `hasFile` is not consulted, since
  // presence at head is exactly what an inherited, untouched review has. A
  // tag: present at head (through `hasFile`, or — without a reader — as a
  // non-deleted diff entry), for the REVIEW.md of every folder that
  // contributed a screenshot.
  const changedInDiff = (file) => list.some((entry) => entry.path === file && isPresentAtHead(entry));
  const presentAtHead = (file) =>
    typeof hasFile === 'function' ? Boolean(hasFile(file)) : changedInDiff(file);
  const hasReviewDocFor = tag ? presentAtHead : changedInDiff;
  const reviewFolders = tag
    ? [...new Set(screenshots.map((entry) => REVIEW_PNG.exec(entry.path)[1]))]
    : [slug];
  const reviewDocs = reviewFolders.map(reviewDocPath);
  // EVERY folder that contributed a counted screenshot must carry its own
  // review document: a tag whose diff spans two evidence folders is not
  // reviewed because one of them was.
  const missingReviewDocs = reviewDocs.filter((doc) => !hasReviewDocFor(doc));
  const hasReviewDoc = reviewDocs.length > 0 && missingReviewDocs.length === 0;
  if (!screenshots.length) {
    const deletedHere = pngs.filter((entry) => !isPresentAtHead(entry) && inFolder(entry));
    const elsewhere = pngs.filter((entry) => isPresentAtHead(entry) && !inFolder(entry));
    const hints = [];
    if (deletedHere.length) {
      hints.push(` This diff only DELETES screenshots under ${expectedFolder} (${deletedHere.length}); a removed file is not evidence.`);
    }
    if (elsewhere.length) {
      hints.push(` This diff only adds screenshots under ${[...new Set(elsewhere.map((entry) => REVIEW_PNG.exec(entry.path)[1]))].map((other) => `docs/design/reviews/${other}/`).join(', ')}, which belong to a different branch.`);
    }
    if (tag) {
      hints.push(' A tag has no branch slug, so a screenshot under any docs/design/reviews/<slug>/ folder in its diff counts; git never required the tagged commit to be pushed through a branch, so the tag itself must carry the evidence.');
    }
    problems.push(
      `GUI diff without committed visual evidence: no .png under ${expectedFolder} is part of this diff.${hints.join('')} Run \`${CAPTURE_COMMAND}\` on this branch and commit the screenshots it writes to ${expectedFolder} (visual-redesign-plan.md §5.1).`,
    );
  }
  if (notPng.length) {
    problems.push(
      `Evidence file${notPng.length > 1 ? 's are' : ' is'} not a readable PNG as committed at head: ${notPng.join(', ')}. A screenshot must start with the 8-byte PNG signature and carry image data (and stay under the evidence size limit); commit the real capture \`${CAPTURE_COMMAND}\` writes.`,
    );
  }
  if (!hasReviewDoc) {
    const expectedDoc = tag
      ? (missingReviewDocs.length ? missingReviewDocs.join(' and ') : reviewDocPath('<slug>'))
      : reviewDocs[0];
    const why = tag
      ? `${missingReviewDocs.length > 1 ? 'are' : 'is'} not present at head`
      : 'is not added or modified in this diff (base...head)';
    problems.push(
      `GUI diff without its review document: ${expectedDoc} ${why}. Screenshots alone are not a review — write the §8 checklist, findings and deviations there (design-system.md §7.3) and commit it${tag ? ' next to the evidence PNGs the tag carries' : ' on this branch, so the review is produced for the evidence this diff adds'}.`,
    );
  }
  const expressions = expressionControlAttributes(patch);
  if (expressions.length) {
    problems.push(
      `data-control must be a string literal so the registry can be checked: ${expressions.map(({ file, value }) => `${file ? `${file}: ` : ''}data-control=${value}`).join(', ')}. Give each rendered control its own literal id (one row per id in ${CONTROL_REGISTRY}).`,
    );
  }
  const controls = addedControlIds(patch);
  if (controls.length) {
    const registered = registryControlIds(registry);
    const registryTouched = list.some((entry) => entry.path === CONTROL_REGISTRY && isPresentAtHead(entry));
    const missing = controls.filter((id) => !registered.has(id));
    if (missing.length) {
      problems.push(
        `New control id${missing.length > 1 ? 's' : ''} ${missing.map((id) => `data-control="${id}"`).join(', ')} added without a registry row: ${registryTouched ? `${CONTROL_REGISTRY} changes in this diff but has no row for ${missing.length > 1 ? 'them' : 'it'} at head` : `${CONTROL_REGISTRY} at head has no row for ${missing.length > 1 ? 'them' : 'it'}`}. Add one row per control with surface · zone · order · visibility rule · precedent and commit it (visual-redesign-plan.md §4.7).`,
      );
    }
    // A registered id that appears in a file where it did not exist at base
    // is a placement change (a move between surfaces, or a second home): the
    // row must be revisited in THIS diff, not merely exist from before.
    // The control's OWN row must be among the registry's changed lines: an
    // unrelated edit to the registry file does not revisit this placement.
    const rowsChanged = changedRegistryRowIds(patch);
    const registeredHere = controls.filter((id) => registered.has(id) && !rowsChanged.has(id));
    if (registeredHere.length) {
      const removed = new Set(removedControlIds(patch));
      const moved = registeredHere.filter((id) => removed.has(id));
      const other = registeredHere.filter((id) => !removed.has(id));
      const parts = [];
      if (moved.length) parts.push(`moved control${moved.length > 1 ? 's' : ''} ${moved.map((id) => `data-control="${id}"`).join(', ')} (removed from one component and added to another)`);
      if (other.length) parts.push(`registered control${other.length > 1 ? 's' : ''} ${other.map((id) => `data-control="${id}"`).join(', ')} added on a surface where ${other.length > 1 ? 'they' : 'it'} did not exist`);
      const how = registryTouched
        ? `${CONTROL_REGISTRY} changes in this diff but ${registeredHere.length > 1 ? 'their rows are' : 'its row is'} not among the changed lines`
        : `without touching ${CONTROL_REGISTRY}`;
      problems.push(
        `${parts.join('; ')} ${how}: a registered id on a new surface is a placement decision — update ${registeredHere.length > 1 ? 'each' : 'its'} registry row (surface · zone · order · visibility rule · precedent) in this diff so the row cannot keep naming the old placement (visual-redesign-plan.md §4.7).`,
      );
    }
  }
  return problems;
}

export function formatGuiEvidenceRefusal(branch, problems) {
  return [
    `Shared review gate refused ${branch} before any reviewer ran: the GUI diff is missing its committed evidence.`,
    ...problems.map((problem) => `  - ${problem}`),
    'Check locally with: node scripts/review-gate/cli.mjs design-evidence --base origin/main --head HEAD',
  ].join('\n');
}
