import { access, open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { LIMITS } from './constants.mjs';
import { processTreeCleanupFailureCode, runProcess } from './process.mjs';
import { addedLinesByFile } from './shards.mjs';

// Deterministic lanes (v1.8.0). The CodeRabbit recall audit counted 14
// markdownlint findings and a Clippy pass among the 84 external findings on
// PRs #417–#430; every one was mechanical and every one cost an external
// round. These lanes run the same tools locally, over CHANGED LINES only,
// with zero model cost and in parallel with the reference map. A lane that
// cannot run (tool missing, timeout, oversize) degrades to an explicit note —
// it never fails the review and it never becomes a PASS on its own.

const MARKDOWN_FILE = /\.(?:md|markdown)$/i;
const RUST_FILE = /^src-tauri\/.*\.rs$/i;
const MAX_MARKDOWN_BYTES = 1024 * 1024;
const MARKDOWNLINT_CONFIG_FILES = ['.markdownlint.jsonc', '.markdownlint.json', '.markdownlint.yaml', '.markdownlint.yml'];

function normalizePath(file) {
  return String(file || '').replace(/\\/g, '/');
}

/**
 * Shape a deterministic hit as an already-verified finding. It skips the
 * adjudicator (a linter hit is a fact, not a hypothesis) and enters the same
 * convergence policy as a model finding; P3 hits are advisories that need a
 * recorded disposition before the head is pushed.
 */
export function deterministicFinding({ source, index, rule, title, file, line, detail, priority = 'P3' }) {
  return {
    candidate_id: `${source}-${index}`,
    title: `${rule}: ${title}`,
    priority,
    file: normalizePath(file),
    line: Number.isInteger(line) && line >= 1 ? line : null,
    disposition: 'verified',
    reason: detail || title,
    scenario: `Reported by ${source} on a line this diff added.`,
    proposed_test: `Run ${source} on the file; the hit disappears once fixed.`,
    source,
    adjudicatedDisposition: 'deterministic',
  };
}

async function readBounded(target, maxBytes) {
  const handle = await open(target, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) return null;
    return buffer.toString('utf8', 0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function loadMarkdownlintModule() {
  return await import('markdownlint/promise');
}

/**
 * Lint in a CHILD process so the lane's bound is a real one: a hung or
 * pathological lint is terminated through the same process fence every
 * provider uses, instead of a race that leaves the work running.
 */
const GATE_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const gateRequire = createRequire(import.meta.url);

// The child imports markdownlint from the GATE's installation, not from
// wherever the caller ran (`--repo` from another directory would otherwise
// resolve nothing and the lane would report no findings).
export function markdownlintModuleUrl(resolve = (specifier) => pathToFileURL(gateRequire.resolve(specifier)).href) {
  try {
    return resolve('markdownlint/promise');
  } catch {
    return 'markdownlint/promise';
  }
}

async function lintInChildProcess({ strings, config, timeoutMs, run, moduleUrl = markdownlintModuleUrl() }) {
  const script = [
    `const { lint } = await import(${JSON.stringify(moduleUrl)});`,
    'const chunks = [];',
    'for await (const chunk of process.stdin) chunks.push(chunk);',
    "const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));",
    'const results = await lint({ strings: input.strings, config: input.config || undefined });',
    'process.stdout.write(JSON.stringify(results));',
  ].join('\n');
  const result = await run(process.execPath, ['--input-type=module', '-e', script], {
    cwd: GATE_DIRECTORY,
    input: JSON.stringify({ strings, config }),
    timeoutMs,
    maxOutputBytes: 8 * 1024 * 1024,
  });
  return JSON.parse(result.stdout);
}

/**
 * Strip `//` and `/* *\/` comments outside string literals so a `.jsonc`
 * config parses; markdownlint's own reader takes parsers for that.
 */
export function stripJsonComments(text) {
  let out = '';
  let inString = false;
  let index = 0;
  const source = String(text || '');
  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];
    if (inString) {
      out += char;
      if (char === '\\' && next !== undefined) {
        out += next;
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === '/' && next === '/') {
      while (index < source.length && source[index] !== '\n') index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      index = end === -1 ? source.length : end + 2;
      continue;
    }
    out += char;
    index += 1;
  }
  return out;
}

const JSONC_PARSERS = [(text) => JSON.parse(stripJsonComments(text))];

/**
 * markdownlint over the changed Markdown files, reporting only hits on added
 * lines. The repository's own `.markdownlint.jsonc` decides the rule set once
 * for this lane AND for CodeRabbit (which honors the same file), instead of
 * the same MD028 hit being dismissed on nine consecutive PRs.
 */
function withTimeout(promise, timeoutMs, label) {
  let timer;
  const bound = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error(`${label} timed out after ${timeoutMs} ms.`), { code: 'TIMEOUT' }));
    }, timeoutMs);
  });
  return Promise.race([promise, bound]).finally(() => clearTimeout(timer));
}

export async function runMarkdownlintLane(options) {
  const timeoutMs = options.timeoutMs ?? LIMITS.markdownlintTimeoutMs;
  // ONE deadline for the whole lane. The in-process setup (module load,
  // config read, bounded file reads) is checked against it, and the lint
  // child process receives exactly the time that remains, so nothing keeps
  // running after the lane reports a timeout: the child is terminated by
  // runProcess through the same process fence every provider uses.
  const deadline = Date.now() + timeoutMs;
  try {
    return await markdownlintLaneBody({ ...options, timeoutMs, deadline });
  } catch (error) {
    if (processTreeCleanupFailureCode(error)) throw error;
    if (error?.code === 'TIMEOUT') {
      return { lane: 'markdownlint', status: 'timeout', note: `markdownlint exceeded ${Math.round(timeoutMs / 1000)} seconds`, findings: [] };
    }
    throw error;
  }
}

function remainingMs(deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw Object.assign(new Error('markdownlint lane deadline passed.'), { code: 'TIMEOUT' });
  return remaining;
}

async function markdownlintLaneBody({
  checkout,
  files,
  patch,
  loadModule = loadMarkdownlintModule,
  maxFindings = LIMITS.maxDeterministicFindings,
  timeoutMs = LIMITS.markdownlintTimeoutMs,
  deadline = Date.now() + timeoutMs,
  run = runProcess,
  lintRunner = null,
}) {
  const targets = (files || []).map(normalizePath).filter((file) => MARKDOWN_FILE.test(file));
  if (!targets.length) return { lane: 'markdownlint', status: 'skipped', note: 'no Markdown file changed', findings: [] };
  let module;
  try {
    module = await withTimeout(loadModule(), remainingMs(deadline), 'markdownlint module load');
  } catch (error) {
    if (error?.code === 'TIMEOUT') throw error;
    return { lane: 'markdownlint', status: 'unavailable', note: `markdownlint could not be loaded: ${error?.message || String(error)}`, findings: [] };
  }
  let config = null;
  for (const name of MARKDOWNLINT_CONFIG_FILES) {
    const candidate = path.join(checkout, name);
    try {
      await access(candidate);
    } catch {
      continue;
    }
    try {
      config = await withTimeout(module.readConfig(candidate, JSONC_PARSERS), remainingMs(deadline), 'markdownlint config');
      break;
    } catch (error) {
      if (error?.code === 'TIMEOUT') throw error;
      return { lane: 'markdownlint', status: 'unavailable', note: `${name} could not be parsed: ${error?.message || String(error)}`, findings: [] };
    }
  }
  const strings = {};
  const oversize = [];
  for (const file of targets) {
    try {
      const text = await withTimeout(readBounded(path.join(checkout, file), MAX_MARKDOWN_BYTES), remainingMs(deadline), 'markdownlint read');
      if (text === null) oversize.push(file);
      else strings[file] = text;
    } catch (error) {
      if (error?.code === 'TIMEOUT') throw error;
      // Deleted or unreadable at head: nothing to lint.
    }
  }
  if (!Object.keys(strings).length) {
    return { lane: 'markdownlint', status: 'skipped', note: 'changed Markdown files are absent at head', findings: [] };
  }
  let results;
  try {
    const budget = remainingMs(deadline);
    results = lintRunner
      ? await withTimeout(lintRunner({ strings, config: config || undefined }), budget, 'markdownlint')
      : await lintInChildProcess({ strings, config: config || undefined, timeoutMs: budget, run });
  } catch (error) {
    if (processTreeCleanupFailureCode(error)) throw error;
    if (error?.code === 'TIMEOUT') throw error;
    return { lane: 'markdownlint', status: 'error', note: `markdownlint failed: ${error?.message || String(error)}`, findings: [] };
  }
  const added = addedLinesByFile(patch);
  const findings = [];
  let total = 0;
  for (const [file, hits] of Object.entries(results || {})) {
    const addedLines = added.get(file);
    for (const hit of hits || []) {
      total += 1;
      if (!addedLines || !addedLines.has(hit.lineNumber)) continue;
      findings.push(deterministicFinding({
        source: 'markdownlint',
        index: findings.length,
        rule: (hit.ruleNames || ['MD'])[0],
        title: hit.ruleDescription || 'Markdown rule violation',
        file,
        line: hit.lineNumber,
        detail: [hit.ruleDescription, hit.errorDetail, hit.errorContext ? `context: ${hit.errorContext}` : null]
          .filter(Boolean).join(' — '),
      }));
    }
  }
  const bounded = findings.slice(0, maxFindings);
  return {
    lane: 'markdownlint',
    status: 'ok',
    note: `${total} hit(s) in ${Object.keys(strings).length} file(s); ${findings.length} on added lines${findings.length > bounded.length ? ` (bounded to ${bounded.length})` : ''}${oversize.length ? `; skipped oversize: ${oversize.join(', ')}` : ''}`,
    findings: bounded,
  };
}

/**
 * Parse `cargo clippy --message-format json` output. Warnings count only on
 * added lines; a compile ERROR is reported wherever it is, because a head
 * that does not compile is a defect the deterministic gates never see
 * (`pnpm verify` builds no Rust).
 */
export function parseClippyMessages(output, { addedLines, crateRoot = 'src-tauri', maxFindings = LIMITS.maxDeterministicFindings } = {}) {
  const findings = [];
  let warnings = 0;
  let errors = 0;
  const seen = new Set();
  for (const rawLine of String(output || '').split(/\r?\n/)) {
    if (!rawLine.startsWith('{')) continue;
    let parsed;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      continue;
    }
    if (parsed?.reason !== 'compiler-message' || !parsed.message) continue;
    const { message } = parsed;
    if (message.level !== 'warning' && message.level !== 'error') continue;
    const span = (message.spans || []).find((entry) => entry.is_primary) || (message.spans || [])[0];
    if (message.level === 'warning') warnings += 1;
    else errors += 1;
    const rule = message.code?.code || (message.level === 'error' ? 'rustc' : 'clippy');
    if (!span?.file_name) {
      // An error without a span (a manifest or linker failure) is still a
      // head that does not compile: report it against the crate manifest.
      if (message.level !== 'error') continue;
      const key = `unlocated:${rule}:${message.message}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push(deterministicFinding({
        source: 'clippy',
        index: findings.length,
        rule,
        title: `Rust compile error: ${message.message}`,
        file: `${crateRoot}/Cargo.toml`,
        line: null,
        detail: `rustc reported an error without a source location in this head: ${message.message}`,
        priority: 'P2',
      }));
      continue;
    }
    const file = normalizePath(path.posix.join(crateRoot, normalizePath(span.file_name)));
    const line = span.line_start;
    const onAddedLine = addedLines?.get(file)?.has(line);
    if (message.level === 'warning' && !onAddedLine) continue;
    const key = `${file}:${line}:${rule}:${message.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push(deterministicFinding({
      source: 'clippy',
      index: findings.length,
      rule,
      title: message.level === 'error' ? `Rust compile error: ${message.message}` : message.message,
      file,
      line,
      detail: message.level === 'error'
        ? `rustc reported an error in this head: ${message.message}`
        : `${message.message}${message.children?.find((child) => child.level === 'help')?.message ? ` (${message.children.find((child) => child.level === 'help').message})` : ''}`,
      priority: message.level === 'error' ? 'P2' : 'P3',
    }));
  }
  // Compile errors are never truncated away behind warnings: they come
  // first, and only the warning tail is bounded.
  const compileErrors = findings.filter((finding) => finding.priority === 'P2');
  const warningFindings = findings.filter((finding) => finding.priority !== 'P2');
  const bounded = [...compileErrors, ...warningFindings].slice(0, maxFindings)
    .map((finding, index) => ({ ...finding, candidate_id: `clippy-${index}` }));
  return { findings: bounded, warnings, errors, truncated: findings.length > bounded.length };
}

/**
 * Clippy over the head checkout's `src-tauri` crate. Uses a dedicated target
 * directory under the gate's state root so the cache is warm across reviews
 * without contending with the developer's own build. The first run on a
 * machine is a cold check and may hit the bound; the lane then reports a
 * timeout note and the next run resumes from the cached artifacts.
 */
export async function runClippyLane({
  checkout,
  files,
  patch,
  stateRoot,
  run = runProcess,
  timeoutMs = LIMITS.clippyTimeoutMs,
  env = process.env,
}) {
  const targets = (files || []).map(normalizePath).filter((file) => RUST_FILE.test(file));
  if (!targets.length) return { lane: 'clippy', status: 'skipped', note: 'no Rust file under src-tauri changed', findings: [] };
  const crateDir = path.join(checkout, 'src-tauri');
  try {
    await access(path.join(crateDir, 'Cargo.toml'));
  } catch {
    return { lane: 'clippy', status: 'skipped', note: 'src-tauri/Cargo.toml is absent at head', findings: [] };
  }
  let result;
  try {
    result = await run('cargo', ['clippy', '--no-deps', '--quiet', '--message-format', 'json'], {
      cwd: crateDir,
      env: { ...env, CARGO_TARGET_DIR: path.join(stateRoot, 'cargo-target') },
      timeoutMs,
      allowFailure: true,
      maxOutputBytes: 16 * 1024 * 1024,
    });
  } catch (error) {
    // The §5 process-tree fence applies to every subprocess the gate launches.
    if (processTreeCleanupFailureCode(error)) throw error;
    if (error?.code === 'TIMEOUT') {
      return { lane: 'clippy', status: 'timeout', note: `cargo clippy exceeded ${Math.round(timeoutMs / 60000)} minutes (a cold cache resumes on the next review)`, findings: [] };
    }
    if (error?.code === 'ENOENT' || /ENOENT/.test(error?.message || '')) {
      return { lane: 'clippy', status: 'unavailable', note: 'cargo is not installed on this host', findings: [] };
    }
    return { lane: 'clippy', status: 'error', note: `cargo clippy failed: ${error?.message || String(error)}`, findings: [] };
  }
  const parsed = parseClippyMessages(result.stdout, { addedLines: addedLinesByFile(patch) });
  const compileErrors = parsed.findings.filter((finding) => finding.priority === 'P2');
  if (result.code !== 0 && !compileErrors.length) {
    // Cargo failed without a parseable compiler error (manifest, lockfile,
    // dependency resolution, toolchain): never a silent "ok".
    const stderr = String(result.stderr || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
    return {
      lane: 'clippy',
      status: 'error',
      note: `cargo clippy exited with code ${result.code} without a located compiler error${stderr ? `: ${stderr.slice(0, 400)}` : ''}`,
      findings: parsed.findings,
    };
  }
  return {
    lane: 'clippy',
    status: 'ok',
    note: `${parsed.warnings} warning(s), ${parsed.errors} error(s); ${parsed.findings.length} reported${parsed.truncated ? ' (bounded)' : ''}`,
    findings: parsed.findings,
  };
}

/**
 * Run every deterministic lane that applies to the diff, in parallel, and
 * return their findings plus a per-lane note for the report. Nothing here
 * can reject except a process-tree cleanup failure, which must reach the
 * gate's fence.
 */
export async function runDeterministicLanes({ checkout, files, patch, stateRoot, run, env, config }) {
  const lanes = await Promise.all([
    runMarkdownlintLane({ checkout, files, patch }),
    config?.clippy === true
      ? runClippyLane({ checkout, files, patch, stateRoot, run, env })
      : Promise.resolve({ lane: 'clippy', status: 'skipped', note: 'execution of project build scripts is not enabled in installed policy', findings: [] }),
  ]);
  // A lane that could not produce diagnostics (a host hiccup, a timeout, an
  // unparseable manifest) is a NOTE in the report and the summary, exactly
  // as the charter states — never a finding that blocks a push or needs a
  // disposition. Its findings, when it did produce them, are enforced.
  const findings = lanes.flatMap((lane) => lane.findings).map((finding, index) => ({
    ...finding,
    candidate_id: `deterministic-${index}`,
  }));
  return {
    lanes: lanes.map(({ lane, status, note }) => ({ lane, status, note })),
    findings,
  };
}
