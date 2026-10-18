import { runGit } from './git.mjs';
import { extractChangedSymbols } from './refmap.mjs';
import { hashText } from './storage.mjs';

// Reusing a shard review after a rebase (1.13.0).
//
// A rebase onto a moved base gives the branch a new merge base, so no earlier
// review is an ancestor of the head and the whole branch was reviewed again
// by fresh reviewers. Most of its hunks are byte-identical to the ones
// already reviewed. A shard review is reused for a full round only when:
//
//   - the shard is the same assignment: the same hunks (with their context),
//     files, kinds, provider, risk, branch and author, under the same
//     installed policy and engine version;
//   - it holds only code, script and test files (documentation and
//     configuration make claims about the whole tree, so they are always
//     reviewed again);
//   - none of its files differs between the head it was reviewed at and this
//     head;
//   - no file that differs between the two heads mentions, as a whole word, at
//     either head, any identifier on the shard's changed lines (what it
//     declares, calls, reads or writes) or the name of one of its files
//     without the extension (and its directory's, for a directory module):
//     a changed definition of anything the hunks use, a changed or removed
//     caller, a re-export in between, all mention one of those names; and
//   - none of the shard's files mentions the name of a file that differs.
//
// That is the bounded claim: textual, not an analysis. A dependency that
// shares no name with the hunks (reflection, configuration, a generated
// name), or an identifier shorter than three characters, is not seen;
// common words are not searched. Candidates are always adjudicated afresh,
// and scouting and hypotheses run on the whole diff as before.

const REUSABLE_KINDS = new Set(['code', 'tests', 'scripts']);
// Past this many distinct changed file names, or names to search, the test is
// not run and the shard is reviewed again.
const MAX_CHANGED_NAMES = 200;
const MAX_SURFACE_NAMES = 4000;
// Words every file of a language contains: searching them would match every
// changed file and never allow a reuse.
const COMMON_WORDS = new Set([
  'abstract', 'and', 'any', 'are', 'as', 'assert', 'async', 'await', 'bool', 'boolean', 'break', 'byte', 'case', 'catch',
  'char', 'class', 'const', 'continue', 'def', 'default', 'del', 'delete', 'do', 'double', 'elif', 'else', 'enum', 'export',
  'extends', 'false', 'final', 'finally', 'float', 'fn', 'for', 'from', 'func', 'function', 'get', 'global', 'impl',
  'implements', 'import', 'in', 'instanceof', 'int', 'interface', 'is', 'lambda', 'let', 'long', 'match', 'mod', 'mut',
  'new', 'none', 'not', 'null', 'number', 'object', 'of', 'or', 'override', 'package', 'pass', 'private', 'protected',
  'pub', 'public', 'raise', 'readonly', 'return', 'self', 'set', 'static', 'str', 'string', 'struct', 'super', 'switch',
  'the', 'this', 'throw', 'throws', 'trait', 'true', 'try', 'type', 'typeof', 'undefined', 'use', 'var', 'void', 'while',
  'with', 'yield',
]);

/** Every identifier of three or more characters on a shard's changed lines. */
export function shardIdentifiers(shard) {
  const names = new Set();
  for (const line of String(shard.patch || '').split(/\r?\n/)) {
    const changed = (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'));
    if (!changed) continue;
    for (const match of line.slice(1).matchAll(/[A-Za-z_$][\w$]{2,}/g)) {
      if (!COMMON_WORDS.has(match[0].toLowerCase())) names.add(match[0]);
    }
  }
  return [...names];
}

/** The digest a reusable review of `shard` is stored under, or null. */
export function shardCacheKey({ shard, provider, policyDigest, repository, risk, branch, author }) {
  const kinds = Array.isArray(shard.kinds) && shard.kinds.length ? shard.kinds : [shard.kind];
  if (shard.reverify || shard.part || !kinds.every((kind) => REUSABLE_KINDS.has(kind))) return null;
  return hashText(JSON.stringify({
    version: 1,
    repository,
    policyDigest,
    provider,
    risk,
    branch,
    author,
    kind: shard.kind,
    kinds,
    files: shard.files,
    patch: hashText(shard.patch, 64),
  }), 40);
}

// A module named after its directory: `./parser` imports parser/index.ts,
// `parser` imports parser/__init__.py or parser/mod.rs.
const DIRECTORY_MODULE = /^(?:index|mod|__init__|main|lib|init)$/i;

/**
 * The names other files use for `file`: its name without the extension, and
 * its directory's name too when the file is the directory's module. Null
 * when one of them is shorter than three characters: such a name cannot be
 * searched as a word reliably.
 */
export function fileNames(file) {
  const parts = String(file).split('/');
  const stem = parts.at(-1).replace(/\.[^.]+$/, '');
  const names = [stem];
  if (DIRECTORY_MODULE.test(stem) && parts.length > 1) names.push(parts.at(-2));
  return names.some((name) => name.length < 3) ? null : names;
}

/** The names a change elsewhere would have to mention to affect this shard. */
export function shardSurface(shard) {
  const names = shard.files.map(fileNames);
  if (names.some((entry) => entry === null)) return null;
  const { symbols } = extractChangedSymbols(shard.patch);
  return [...new Set([...names.flat(), ...symbols, ...shardIdentifiers(shard)])];
}

/**
 * Whether a review of `shard` made at `reviewedHead` still holds at
 * `headSha`. Any Git failure answers no: the shard is then reviewed again.
 */
export async function rebaseReuseAllowed(repoRoot, { shard, reviewedHead, headSha, run = runGit }) {
  if (!/^[0-9a-f]{40}$/.test(String(reviewedHead)) || !/^[0-9a-f]{40}$/.test(String(headSha))) return false;
  const surface = shardSurface(shard);
  if (!surface || !surface.length || surface.length > MAX_SURFACE_NAMES) return false;
  const quiet = { allowFailure: true, result: true, latchCleanupFailure: false };
  try {
    // NUL-separated output: paths arrive verbatim, never Git-quoted.
    const diff = await run(repoRoot, ['diff', '--name-only', '-z', '--no-renames', reviewedHead, headSha], quiet);
    if (diff.code !== 0) return false;
    const changed = new Set(String(diff.stdout).split('\0').filter(Boolean));
    if (!changed.size) return true;
    if (shard.files.some((file) => changed.has(file))) return false;
    // The files of `tree` that mention any of `names` as a whole word. The
    // names travel on standard input, so their number is not bound by the
    // command line.
    const filesMentioning = async (names, tree) => {
      const grep = await run(repoRoot, ['grep', '-l', '-z', '-w', '--fixed-strings', '-f', '-', tree, '--'], {
        ...quiet, input: `${names.join('\n')}\n`,
      });
      if (grep.code === 1) return new Set();
      if (grep.code !== 0) return null;
      return new Set(String(grep.stdout).split('\0').filter(Boolean)
        .map((line) => (line.startsWith(`${tree}:`) ? line.slice(tree.length + 1) : line)));
    };
    // Something that changed uses or is used by the shard's names, as it is
    // now or as it was (a caller that dropped its last use is a change too).
    for (const tree of [headSha, reviewedHead]) {
      const mentioning = await filesMentioning(surface, tree);
      if (!mentioning || [...mentioning].some((file) => changed.has(file))) return false;
    }
    // The shard names a changed file (an import, an include, a path). A
    // changed file with a name shorter than three characters, or too many
    // changed files to name, cannot be checked this way.
    const named = [...changed].map(fileNames);
    if (named.some((entry) => entry === null)) return false;
    const changedNames = [...new Set(named.flat())];
    if (changedNames.length > MAX_CHANGED_NAMES) return false;
    const dependents = await filesMentioning(changedNames, headSha);
    return Boolean(dependents) && !shard.files.some((file) => dependents.has(file));
  } catch {
    return false;
  }
}
