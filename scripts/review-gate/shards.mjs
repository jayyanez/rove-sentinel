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
    text: section.lines.join('\n'),
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
 * file larger than the target gets its own shard. The result is deterministic
 * for a given patch.
 */
export function partitionShards(patch, {
  targetLines = LIMITS.shardTargetLines,
  maxShards = LIMITS.shardMaxCountHigh,
  excludedFiles = [],
} = {}) {
  const excluded = new Set(excludedFiles.map((file) => String(file).replace(/\\/g, '/')));
  const sections = splitPatchByFile(patch)
    .filter((section) => !excluded.has(section.file))
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
  // Bytes bound a shard as well as changed lines: rename-only and binary
  // sections carry zero changed lines but real text, and a shard exists to
  // be read in one bounded read.
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
