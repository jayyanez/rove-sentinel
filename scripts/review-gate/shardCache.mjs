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
//     head; and
//   - no file that differs between the two heads mentions, as a whole word,
//     a name the shard declares or removes, or the name of one of its files
//     without the extension (the name an import or include uses); and
//   - none of the shard's files mentions, as a whole word, the name of a file
//     that differs (a dependency the shard imports or includes).
//
// The last rule is what stands in for "nothing the hunks depend on
// changed". It is a textual test, not an analysis: a dependency that names
// neither (reached through reflection, a generic name shorter than three
// characters, configuration) is not seen, which is why a shard whose file
// name is shorter than three characters is never reused. Candidates are
// always adjudicated afresh, and scouting and hypotheses run on the whole
// diff as before.

const REUSABLE_KINDS = new Set(['code', 'tests', 'scripts']);
// Past this many distinct changed file names the dependency test is not run
// and the shard is reviewed again.
const MAX_CHANGED_NAMES = 200;

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
  return [...new Set([...names.flat(), ...symbols])];
}

/**
 * Whether a review of `shard` made at `reviewedHead` still holds at
 * `headSha`. Any Git failure answers no: the shard is then reviewed again.
 */
export async function rebaseReuseAllowed(repoRoot, { shard, reviewedHead, headSha, run = runGit }) {
  if (!/^[0-9a-f]{40}$/.test(String(reviewedHead)) || !/^[0-9a-f]{40}$/.test(String(headSha))) return false;
  const surface = shardSurface(shard);
  if (!surface || !surface.length) return false;
  const quiet = { allowFailure: true, result: true, latchCleanupFailure: false };
  try {
    // NUL-separated output: paths arrive verbatim, never Git-quoted.
    const diff = await run(repoRoot, ['diff', '--name-only', '-z', '--no-renames', reviewedHead, headSha], quiet);
    if (diff.code !== 0) return false;
    const changed = new Set(String(diff.stdout).split('\0').filter(Boolean));
    if (!changed.size) return true;
    if (shard.files.some((file) => changed.has(file))) return false;
    const filesMentioning = async (names) => {
      const grep = await run(repoRoot, [
        'grep', '-l', '-z', '-w', '--fixed-strings', ...names.flatMap((name) => ['-e', name]), headSha, '--',
      ], quiet);
      if (grep.code === 1) return new Set();
      if (grep.code !== 0) return null;
      return new Set(String(grep.stdout).split('\0').filter(Boolean)
        .map((line) => (line.startsWith(`${headSha}:`) ? line.slice(headSha.length + 1) : line)));
    };
    // Something that changed uses the shard ...
    const users = await filesMentioning(surface);
    if (!users || [...users].some((file) => changed.has(file))) return false;
    // ... or the shard uses something that changed: one of its files names a
    // changed file (an import, an include, a path). A changed file with a
    // name shorter than three characters, or too many changed files to name,
    // cannot be checked this way.
    const named = [...changed].map(fileNames);
    if (named.some((entry) => entry === null)) return false;
    const changedNames = [...new Set(named.flat())];
    if (changedNames.length > MAX_CHANGED_NAMES) return false;
    const dependents = await filesMentioning(changedNames);
    return Boolean(dependents) && !shard.files.some((file) => dependents.has(file));
  } catch {
    return false;
  }
}
