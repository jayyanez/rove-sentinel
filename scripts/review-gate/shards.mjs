import { LIMITS } from './constants.mjs';

// Sharded coverage (v1.8.0). The 2026-09-01 CodeRabbit recall audit found
// that the gate's whole-diff coverage reviewers physically could not read a
// 100–300 KB patch inside a 12-read budget ("Read budget exhausted after
// covering the core hunks"), so the 12 escapes the gate never surfaced sat in
// hunks nobody reached: scripts, launch-shim, resource adapters, tests, docs.
// A shard is a deterministic file group of roughly `shardTargetLines` changed
// lines; every changed hunk belongs to exactly one shard, and a shard
// reviewer reads its shard in one bounded read and spends the rest of its
// budget verifying usage sites.

const DOC_FILE = /\.(?:md|mdx|markdown|rst|txt|adoc)$/i;
const TEST_FILE = /(?:^|\/)(?:tests?|__tests__|fixtures)(?:\/|$)|\.(?:test|spec)\.[^.]+$/i;
const SCRIPT_FILE = /^(?:scripts|\.githooks|\.github|src-tauri\/launch-shim|src-tauri\/resources|sidecar)\//i;
const CONFIG_FILE = /\.(?:json|jsonc|ya?ml|toml|lock|conf|ini)$/i;

/** Lens family a shard reviewer applies; decided by the dominant file kind. */
export function classifyShardFile(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  // Location wins over extension: a Markdown fixture under tests/ is test
  // material and gets the tests lens, not the docs one.
  if (TEST_FILE.test(normalized)) return 'tests';
  if (DOC_FILE.test(normalized)) return 'docs';
  if (SCRIPT_FILE.test(normalized)) return 'scripts';
  if (CONFIG_FILE.test(normalized)) return 'config';
  return 'code';
}

/**
 * Decode a Git-quoted path (`core.quotePath` default quotes non-ASCII and
 * control bytes as C-style escapes with octal UTF-8 bytes).
 */
export function unquoteGitPath(quoted) {
  const text = String(quoted || '');
  if (!text.includes('\\')) return text;
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char !== '\\') {
      bytes.push(...Buffer.from(char, 'utf8'));
      continue;
    }
    const next = text[index + 1];
    const octal = /^[0-7]{3}/.exec(text.slice(index + 1));
    if (octal) {
      bytes.push(parseInt(octal[0], 8) & 0xff);
      index += 3;
      continue;
    }
    const simple = { n: 10, t: 9, r: 13, b: 8, f: 12, v: 11, a: 7, '"': 34, '\\': 92 };
    if (next !== undefined && Object.hasOwn(simple, next)) {
      bytes.push(simple[next]);
      index += 1;
      continue;
    }
    bytes.push(92);
  }
  return Buffer.from(bytes).toString('utf8');
}

const DIFF_HEADER = /^diff --git (?:"a\/((?:[^"\\]|\\.)*)"|a\/(.+?)) (?:"b\/((?:[^"\\]|\\.)*)"|b\/(.+))$/;

/**
 * The unambiguous target-path lines a section may carry before its hunks:
 * `+++ b/<path>` (text diffs) and `rename to <path>` (rename-only and binary
 * renames, which have no `+++` line). Either may be Git-quoted.
 */
function plusPlusPlusPath(line) {
  if (line.startsWith('+++ ')) {
    const quoted = /^\+\+\+ "b\/((?:[^"\\]|\\.)*)"/.exec(line);
    if (quoted) return unquoteGitPath(quoted[1]);
    const plain = /^\+\+\+ b\/(.+?)(?:\t.*)?$/.exec(line);
    return plain ? plain[1] : null;
  }
  if (line.startsWith('rename to ')) {
    const quoted = /^rename to "((?:[^"\\]|\\.)*)"$/.exec(line);
    if (quoted) return unquoteGitPath(quoted[1]);
    return line.slice('rename to '.length) || null;
  }
  return null;
}

function patchTargetPath(headerLine) {
  // `diff --git a/<old> b/<new>`, either side possibly Git-quoted; take the
  // b/ side. Quoted paths are unambiguous. For unquoted paths (which may
  // contain spaces and even " b/"), Git repeats the same path on both sides
  // unless the file was renamed, so prefer the split where old === new and
  // fall back to the first " b/" only for a rename.
  const match = DIFF_HEADER.exec(headerLine);
  if (!match) return null;
  if (match[3] !== undefined) return unquoteGitPath(match[3]);
  const rest = headerLine.slice('diff --git a/'.length);
  let search = 0;
  while (true) {
    const at = rest.indexOf(' b/', search);
    if (at === -1) break;
    const left = rest.slice(0, at);
    const right = rest.slice(at + 3);
    if (left === right) return right;
    search = at + 1;
  }
  return match[4];
}

/**
 * Split a unified patch into per-file sections with their added/removed line
 * counts. Pure text work; a malformed patch yields whatever sections it can.
 */
export function splitPatchByFile(patch) {
  const sections = [];
  let current = null;
  for (const rawLine of String(patch || '').split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      if (current) sections.push(current);
      current = {
        file: patchTargetPath(rawLine) || `(unparsed section ${sections.length + 1})`,
        lines: [rawLine],
        changedLines: 0,
        sawHunk: false,
      };
      continue;
    }
    if (!current) continue;
    current.lines.push(rawLine);
    // The `+++ b/<path>` line is unambiguous where the header's " b/" split
    // is not (an unquoted rename whose old path contains " b/"): prefer it.
    if (!current.sawHunk) {
      if (rawLine.startsWith('@@ ')) current.sawHunk = true;
      const target = plusPlusPlusPath(rawLine);
      if (target) current.file = target;
      const renamedFrom = renameFromPath(rawLine);
      if (renamedFrom) current.renamedFrom = renamedFrom;
      if (BINARY_MARKER.test(rawLine)) current.binary = true;
      if (rawLine.startsWith('old mode ')) current.modeChange = true;
      if (rawLine.startsWith('copy from ')) current.copied = true;
      if (rawLine.startsWith('new file mode ') || rawLine.startsWith('deleted file mode ')) current.createdOrDeleted = true;
    }
    if (
      (rawLine.startsWith('+') && !rawLine.startsWith('+++')) ||
      (rawLine.startsWith('-') && !rawLine.startsWith('---'))
    ) {
      current.changedLines += 1;
    }
  }
  if (current) sections.push(current);
  return sections.map((section) => ({
    file: section.file,
    ...(section.renamedFrom ? { renamedFrom: section.renamedFrom } : {}),
    kind: classifyShardFile(section.file),
    changedLines: section.changedLines,
    ...(section.sawHunk ? {} : { metadataReason: metadataReason(section) }),
    text: section.lines.join('\n'),
  }));
}

// Git's summary of a binary change (`git diff` without --binary) and the
// header of a `--binary` patch; either means there is no text to review.
const BINARY_MARKER = /^(?:Binary files .* differ|GIT binary patch)$/;

/**
 * Why a section has no textual hunk. Such a section carries no text a
 * reviewer can read — binary content, a rename or copy without content
 * change, a mode change, an empty file created or deleted — so it owns no
 * shard (1.11.1).
 */
function metadataReason(section) {
  if (section.binary) return 'binary';
  if (section.renamedFrom) return 'rename';
  if (section.copied) return 'copy';
  if (section.modeChange) return 'mode';
  if (section.createdOrDeleted) return 'empty';
  return 'other';
}

/**
 * The changed files that have no textual hunk, in code-unit path order, with
 * the reason and the old path of a rename. They stay in the full patch and
 * in the review context, where every reviewer checks references to their
 * paths; no shard owns them because there is nothing in them to read.
 * Excluded files (visual baselines) are reported separately and left out.
 */
export function metadataOnlySections(patch, { excludedFiles = [] } = {}) {
  const excluded = new Set(excludedFiles.map((file) => String(file).replace(/\\/g, '/')));
  return splitPatchByFile(patch)
    .filter((section) => section.metadataReason && !excluded.has(section.file))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .map((section) => ({
      file: section.file,
      ...(section.renamedFrom ? { renamedFrom: section.renamedFrom } : {}),
      reason: section.metadataReason,
    }));
}

/** old path → new path for every renamed section of the patch. */
/**
 * Old path → new path for every rename the head carries: the branch diff
 * always (a full round propagates recorded deferrals through renames too),
 * plus the incremental diff when the round has one.
 */
export function renameMapFor(patch, followUpPatch = null) {
  return new Map([
    ...renamedPaths(patch),
    ...(typeof followUpPatch === 'string' ? renamedPaths(followUpPatch) : []),
  ]);
}

export function renamedPaths(patch) {
  return new Map(splitPatchByFile(patch)
    .filter((section) => section.renamedFrom)
    .map((section) => [section.renamedFrom, section.file]));
}

/** `rename from <path>` (possibly quoted) → the old path, or null. */
function renameFromPath(line) {
  if (!line.startsWith('rename from ')) return null;
  const quoted = /^rename from "((?:[^"\\]|\\.)*)"$/.exec(line);
  if (quoted) return unquoteGitPath(quoted[1]);
  return line.slice('rename from '.length) || null;
}

/**
 * Added-line numbers per file (new-side numbering), for deterministic lanes
 * that must report only what the diff touched.
 */
export function addedLinesByFile(patch) {
  const result = new Map();
  let file = null;
  let newLine = 0;
  let inHunk = false;
  for (const rawLine of String(patch || '').split(/\r?\n/)) {
    if (rawLine.startsWith('diff --git ')) {
      file = patchTargetPath(rawLine);
      newLine = 0;
      inHunk = false;
      continue;
    }
    if (!file) continue;
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(rawLine);
    if (hunk) {
      newLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    // Section metadata (similarity index, rename from/to, +++/---) precedes
    // the first hunk and never advances the new-side line counter.
    if (!inHunk) {
      const target = plusPlusPlusPath(rawLine);
      if (target) file = target;
      continue;
    }
    if (rawLine.startsWith('+')) {
      if (!result.has(file)) result.set(file, new Set());
      result.get(file).add(newLine);
      newLine += 1;
    } else if (rawLine.startsWith('-')) {
      // removed line: new-side numbering does not advance
    } else if (rawLine.startsWith('\\')) {
      // "\ No newline at end of file"
    } else {
      newLine += 1;
    }
  }
  return result;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Bound the context of every hunk by bytes as well as lines (1.12.0). Git
 * gives each change `patchContextLines` lines either side whatever their
 * length; here each side of a change run keeps the lines nearest the change
 * up to `sideBytes`, and never fewer than `minLines`. Context between two
 * runs that no longer meets splits the hunk, with headers recomputed, so the
 * result is still a patch that applies. Every added and removed line is kept:
 * only context is dropped. A hunk that already fits is returned byte for
 * byte; one whose start moves loses Git's function heading, which named the
 * line before the old start. Text that is not a well-formed hunk is left
 * alone.
 */
export function boundPatchContext(patch, {
  sideBytes = LIMITS.patchContextSideBytes,
  minLines = LIMITS.patchContextMinLines,
} = {}) {
  const lines = String(patch ?? '').split('\n');
  const floor = Math.max(1, minLines);
  const out = [];
  let index = 0;
  while (index < lines.length) {
    const header = HUNK_HEADER.exec(lines[index]);
    if (!header) {
      out.push(lines[index]);
      index += 1;
      continue;
    }
    const hunk = readHunk(lines, index, header);
    out.push(...(hunk.items ? trimHunk(hunk.items, lines[index], header, sideBytes, floor) : lines.slice(index, hunk.end)));
    index = hunk.end;
  }
  return out.join('\n');
}

/**
 * The body of the hunk whose header is `lines[start]`, as items of one diff
 * line each (a `\ No newline` marker stays with its line). The header's
 * counts decide where the body ends; `items` is null when the body does not
 * match them.
 */
function readHunk(lines, start, header) {
  let oldRemaining = header[2] === undefined ? 1 : Number(header[2]);
  let newRemaining = header[4] === undefined ? 1 : Number(header[4]);
  const items = [];
  let index = start + 1;
  while (index < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
    const kind = lines[index][0];
    if (kind === '\\' && items.length) {
      items[items.length - 1].lines.push(lines[index]);
    } else if (kind === ' ' && oldRemaining > 0 && newRemaining > 0) {
      oldRemaining -= 1;
      newRemaining -= 1;
      items.push({ kind, lines: [lines[index]] });
    } else if (kind === '-' && oldRemaining > 0) {
      oldRemaining -= 1;
      items.push({ kind, lines: [lines[index]] });
    } else if (kind === '+' && newRemaining > 0) {
      newRemaining -= 1;
      items.push({ kind, lines: [lines[index]] });
    } else {
      return { end: index, items: null };
    }
    index += 1;
  }
  if (oldRemaining > 0 || newRemaining > 0) return { end: index, items: null };
  if (index < lines.length && lines[index][0] === '\\' && items.length) {
    items[items.length - 1].lines.push(lines[index]);
    index += 1;
  }
  return { end: index, items };
}

function trimHunk(items, headerLine, header, sideBytes, floor) {
  const whole = () => [headerLine, ...items.flatMap((item) => item.lines)];
  const itemBytes = (item) => item.lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0);
  // How many context items to keep, counted from the change outwards.
  const keepCount = (stretch) => {
    let count = 0;
    let bytes = 0;
    for (const item of stretch) {
      const size = itemBytes(item);
      if (count >= floor && bytes + size > sideBytes) break;
      count += 1;
      bytes += size;
    }
    return count;
  };
  const keep = items.map((item) => item.kind !== ' ');
  const lastChange = keep.lastIndexOf(true);
  if (lastChange === -1) return whole();
  let from = 0;
  while (from < items.length) {
    if (items[from].kind !== ' ') {
      from += 1;
      continue;
    }
    let to = from;
    while (to < items.length && items[to].kind === ' ') to += 1;
    const stretch = items.slice(from, to);
    // Context after a change keeps its first lines, context before one its
    // last; a stretch between two changes keeps both ends, or all of it when
    // the two ends meet.
    const after = from > 0 ? keepCount(stretch) : 0;
    const before = to <= lastChange ? keepCount([...stretch].reverse()) : 0;
    if (after + before >= stretch.length) {
      keep.fill(true, from, to);
    } else {
      keep.fill(true, from, from + after);
      keep.fill(true, to - before, to);
    }
    from = to;
  }
  if (keep.every(Boolean)) return whole();
  // Something was dropped, so the hunk had context, and every kept run holds
  // at least one context line (floor >= 1): both its counts are positive and
  // its starts are real line numbers.
  const range = (startAt, count) => (count === 1 ? `${startAt}` : `${startAt},${count}`);
  const result = [];
  let oldLine = Number(header[1]);
  let newLine = Number(header[3]);
  let segment = null;
  const flush = () => {
    if (!segment) return;
    result.push(
      `@@ -${range(segment.oldStart, segment.oldCount)} +${range(segment.newStart, segment.newCount)} @@${segment.heading}`,
      ...segment.lines,
    );
    segment = null;
  };
  items.forEach((item, position) => {
    const onOld = item.kind !== '+';
    const onNew = item.kind !== '-';
    if (keep[position]) {
      segment ??= {
        oldStart: null, newStart: null, oldCount: 0, newCount: 0, lines: [],
        heading: position === 0 ? headerLine.slice(header[0].length) : '',
      };
      if (onOld) {
        segment.oldStart ??= oldLine;
        segment.oldCount += 1;
      }
      if (onNew) {
        segment.newStart ??= newLine;
        segment.newCount += 1;
      }
      segment.lines.push(...item.lines);
    } else {
      flush();
    }
    if (onOld) oldLine += 1;
    if (onNew) newLine += 1;
  });
  flush();
  return result;
}

const KIND_ORDER = { code: 0, config: 1, scripts: 2, tests: 3, docs: 4 };

function dominantKind(files) {
  const weight = new Map();
  for (const file of files) {
    weight.set(file.kind, (weight.get(file.kind) || 0) + Math.max(1, file.changedLines));
  }
  return [...weight.entries()].sort((a, b) => b[1] - a[1] || KIND_ORDER[a[0]] - KIND_ORDER[b[0]])[0]?.[0] || 'code';
}

/**
 * Partition the patch into at most `maxShards` shards of about `targetLines`
 * changed lines. Files are ordered by kind (code first, docs last) and then
 * by path, so a shard groups related files, and a shard never mixes docs with
 * code when the diff has enough of each to fill separate shards. A single
 * file larger than the target gets its own shard. Sections without a textual
 * hunk own no shard (see metadataOnlySections). The result is deterministic
 * for a given patch.
 */
export function partitionShards(patch, {
  targetLines = LIMITS.shardTargetLines,
  maxShards = LIMITS.shardMaxCountHigh,
  excludedFiles = [],
} = {}) {
  const excluded = new Set(excludedFiles.map((file) => String(file).replace(/\\/g, '/')));
  // A section without a textual hunk has nothing a reviewer can read: it is
  // listed in the review context (metadataOnlySections) instead of filling
  // shards with files whose owner would have to report its review incomplete.
  const sections = splitPatchByFile(patch)
    .filter((section) => !excluded.has(section.file) && !section.metadataReason)
    .sort((a, b) => (
      // Code-unit order, never the host locale's collation: identical patch
      // bytes must always produce identical shards.
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0)
    ));
  if (!sections.length) return [];
  const total = sections.reduce((sum, section) => sum + section.changedLines, 0);
  // Raise the target when the diff cannot fit into maxShards shards at the
  // requested size: the count stays bounded and every hunk stays covered.
  const effectiveTarget = Math.max(targetLines, Math.ceil(total / Math.max(1, maxShards)));
  // Bytes bound a shard as well as changed lines: a section with few changed
  // lines can still carry a lot of text (long lines, wide context), and a
  // shard exists to be read in one bounded read.
  const byteLength = (text) => Buffer.byteLength(text, 'utf8');
  const baseMaxBytes = Math.max(64 * 1024, Math.ceil(byteLength(String(patch || '')) / Math.max(1, maxShards)));
  const sized = sections.map((section) => ({ section, bytes: byteLength(section.text) }));
  const fill = (lineTarget, byteTarget) => {
    const result = [];
    let current = null;
    for (const { section, bytes } of sized) {
      const wouldOverflow = current && (
        current.changedLines + section.changedLines > lineTarget ||
        current.bytes + bytes > byteTarget
      );
      const kindChanges = current && current.kind !== section.kind && current.changedLines >= lineTarget / 2;
      if (!current || wouldOverflow || kindChanges) {
        if (current) result.push(current);
        current = { files: [], changedLines: 0, bytes: 0, kind: section.kind };
      }
      current.files.push(section);
      current.changedLines += section.changedLines;
      current.bytes += bytes;
    }
    if (current) result.push(current);
    return result;
  };
  let shards = fill(effectiveTarget, baseMaxBytes);
  // When path-ordered filling cannot meet the cap at a balanced size, pack
  // by size instead (largest first into the lightest shard): the reviewer
  // cap is the hard bound and the shards stay as even as the sections allow.
  if (shards.length > maxShards) {
    const bins = Array.from({ length: Math.max(1, maxShards) }, () => ({ files: [], changedLines: 0, bytes: 0, kind: 'mixed' }));
    const bySize = [...sized].sort((a, b) => b.bytes - a.bytes || b.section.changedLines - a.section.changedLines || (a.section.file < b.section.file ? -1 : 1));
    for (const { section, bytes } of bySize) {
      const lightest = bins.reduce((best, bin) => (bin.bytes < best.bytes ? bin : best), bins[0]);
      lightest.files.push(section);
      lightest.changedLines += section.changedLines;
      lightest.bytes += bytes;
    }
    shards = bins.filter((bin) => bin.files.length);
    for (const bin of shards) {
      bin.files.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
    }
  }
  while (shards.length > maxShards) {
    let best = 0;
    const weight = (index) => shards[index].bytes + shards[index + 1].bytes + (shards[index].changedLines + shards[index + 1].changedLines) * 64;
    for (let index = 1; index < shards.length - 1; index += 1) {
      if (weight(index) < weight(best)) best = index;
    }
    const merged = {
      files: [...shards[best].files, ...shards[best + 1].files],
      changedLines: shards[best].changedLines + shards[best + 1].changedLines,
      bytes: shards[best].bytes + shards[best + 1].bytes,
      kind: 'mixed',
    };
    shards.splice(best, 2, merged);
  }
  return shards.map((shard, index) => ({
    index,
    kind: dominantKind(shard.files),
    files: shard.files.map((section) => section.file),
    changedLines: shard.changedLines,
    patch: `${shard.files.map((section) => section.text).join('\n')}\n`,
  }));
}

/**
 * Split one shard's patch into parts a reviewer reads whole, one call each
 * (1.11.1). Parts break between files where a file fits; a file larger than a
 * part is split between lines, and each continuation part starts with a line
 * naming the file it continues. A single line longer than a part is cut
 * between characters (1.12.0), each further piece opening a part that says
 * so, so no part exceeds `maxBytes`: a line that kept a part of its own could
 * be larger than any read. Concatenating the parts without their continuation
 * lines gives the shard patch back.
 */
export function splitShardPatch(patch, maxBytes = LIMITS.shardPartMaxBytes) {
  return splitShardPatchParts(patch, maxBytes).map((part) => part.text);
}

/** The parts of `splitShardPatch`, each with the files it holds text of. */
function splitShardPatchParts(patch, maxBytes) {
  const text = String(patch || '');
  const bytes = (value) => Buffer.byteLength(value, 'utf8');
  if (bytes(text) <= maxBytes) {
    return [{ text, files: splitPatchByFile(text).map((section) => section.file) }];
  }
  const parts = [];
  let current = '';
  let files = [];
  let currentFile = null;
  let inHeader = false;
  const flush = () => {
    if (current) parts.push({ text: current, files });
    current = '';
    files = [];
  };
  const continuation = (how) => `${CONTINUATION_PREFIX}${currentFile || 'the previous file'} (${how})\n`;
  const withinLine = 'the previous part ends inside one of its lines, which continues here';
  for (const line of text.split(/(?<=\n)/)) {
    const startsFile = line.startsWith('diff --git ');
    const bare = line.replace(/\r?\n$/, '');
    if (startsFile) {
      currentFile = patchTargetPath(bare) || currentFile;
      inHeader = true;
    } else if (inHeader) {
      if (line.startsWith('@@ ')) inHeader = false;
      // As in splitPatchByFile, `+++ b/<path>` settles a path the header
      // leaves ambiguous, so a part names the file sharding named.
      const target = plusPlusPlusPath(bare);
      if (target && target !== currentFile) {
        files = files.map((file) => (file === currentFile ? target : file));
        currentFile = target;
      }
    }
    const room = Math.max(1, maxBytes - bytes(continuation(withinLine)));
    cutLine(line, room).forEach((piece, pieceIndex) => {
      if (pieceIndex > 0) {
        flush();
        current = continuation(withinLine);
      } else if (current && bytes(current) + bytes(piece) > maxBytes) {
        flush();
        // A file starts on a fresh part when it would not fit whole here.
        if (!startsFile) current = continuation('the previous part ends inside it');
      }
      current += piece;
      if (currentFile && !files.includes(currentFile)) files.push(currentFile);
    });
  }
  flush();
  return parts;
}

/** A line longer than `maxBytes` cut between characters into pieces of at
 *  most `maxBytes` UTF-8 bytes each. */
export function cutLine(line, maxBytes) {
  if (Buffer.byteLength(line, 'utf8') <= maxBytes) return [line];
  const pieces = [];
  let piece = '';
  let size = 0;
  for (const char of line) {
    const bytes = Buffer.byteLength(char, 'utf8');
    if (size + bytes > maxBytes) {
      pieces.push(piece);
      piece = '';
      size = 0;
    }
    piece += char;
    size += bytes;
  }
  if (piece) pieces.push(piece);
  return pieces;
}

/**
 * One shard per part of `shard` (1.12.0), for the retry that hands a shard
 * over one part per reviewer: a reviewer given a single part cannot lose one
 * by reading several in one command. Each prior blocker the shard re-verifies
 * goes to exactly one part — the first that holds its file, else the first
 * part — so a blocker missing from the merged result still means what it
 * means for the whole shard.
 */
export function shardPartShards(shard, maxBytes = LIMITS.shardPartMaxBytes) {
  const parts = splitShardPatchParts(shard.patch, maxBytes);
  const partOf = (file) => Math.max(0, parts.findIndex((part) => part.files.includes(file)));
  const changed = (text) => text.split('\n').filter((line) => (
    (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'))
  )).length;
  return parts.map((part, index) => ({
    ...shard,
    files: part.files,
    changedLines: changed(part.text),
    patch: part.text,
    part: { index, count: parts.length },
    reverifyBlockers: (shard.reverifyBlockers || []).filter((finding) => partOf(finding.file) === index),
    unassignedBlockers: index === 0 ? (shard.unassignedBlockers || []) : [],
  }));
}

/** First line of a shard part that continues a file from the previous part. */
export const CONTINUATION_PREFIX = '# Sentinel shard part continues: ';

/**
 * A shard reviewer's time limit (1.11.1): the base for a shard of one part,
 * one more minute for each further `shardTimeoutStepBytes`, bounded by
 * `shardTimeoutMaxMs`. Deterministic for a given patch.
 */
export function shardTimeoutMs(patch) {
  const extraBytes = Math.max(0, Buffer.byteLength(String(patch || ''), 'utf8') - LIMITS.shardPartMaxBytes);
  const extraMinutes = Math.ceil(extraBytes / LIMITS.shardTimeoutStepBytes);
  return Math.min(LIMITS.shardTimeoutMaxMs, LIMITS.shardTimeoutMs + extraMinutes * 60 * 1000);
}
