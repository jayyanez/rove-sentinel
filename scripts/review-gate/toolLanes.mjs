import { access, mkdir, mkdtemp, open, readdir, readFile, realpath, rm, stat, symlink, unlink, writeFile, lstat } from 'node:fs/promises';
import { realpath as realpathCallback } from 'node:fs';
import os from 'node:os';
import { promisify } from 'node:util';
import path from 'node:path';

import { LIMITS } from './constants.mjs';
import { processTreeCleanupFailureCode, runProcess } from './process.mjs';
import { addedLinesByFile } from './shards.mjs';

// The operating system's own resolution: it also expands a Windows 8.3 name.
const realpathNative = promisify(realpathCallback.native);

// Linter lanes (1.13.0). CodeRabbit runs dozens of static analyzers beside
// its model review; Sentinel ran markdownlint and an opt-in Clippy. These
// lanes run the common ones over the changed files and report hits on added
// lines, with no model call:
//
//   - shellcheck (shell scripts), actionlint (GitHub workflows), gitleaks
//     (committed secrets) and ruff (Python) run whenever they are installed
//     on the host. They analyze text and never execute repository code.
//   - Project commands (tsc, eslint, a project's own checker) run only when
//     the installed policy lists them (`lintCommands`): they execute the
//     project's toolchain and configuration from the reviewed head, like the
//     opt-in Clippy lane, so only trusted code may enable them.
//
// A tool that is missing, times out or fails is a note in the report, never
// a finding and never a PASS on its own. Hits are deterministic findings: a
// P3 needs a fix or a recorded deferral, a P2 blocks like a verified one.

const SHELL_EXTENSION = /\.(?:sh|bash)$/i;
const SHELL_SHEBANG = /^#!\s*(?:\/usr\/bin\/env\s+)?(?:\S*\/)?(?:sh|bash|dash|ksh)\b/;
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/i;
const PYTHON_FILE = /\.pyi?$/i;
const TEST_PATH = /(?:^|\/)(?:tests?|__tests__|fixtures?|testdata|spec)(?:\/|$)|\.(?:test|spec)\.[^.]+$|(?:^|\/)test_[^/]+\.py$|_test\.(?:go|py)$/i;
const MAX_LANE_FILES = 200;
const MAX_SCAN_FILE_BYTES = 1024 * 1024;
const MAX_SCAN_TOTAL_BYTES = 32 * 1024 * 1024;
const MAX_LANE_OUTPUT_BYTES = 8 * 1024 * 1024;

export const BUILTIN_TOOL_LANES = Object.freeze(['shellcheck', 'actionlint', 'gitleaks', 'ruff']);

function normalize(file) {
  return String(file || '').replace(/\\/g, '/');
}

/** A changed path as the checkout knows it, or null for an absolute path outside it. */
export function checkoutRelative(file, checkout) {
  const value = normalize(file);
  const root = normalize(checkout).replace(/\/+$/, '');
  if (!/^(?:[A-Za-z]:\/|\/)/.test(value)) return value.replace(/^\.\//, '');
  const sameCase = process.platform === 'win32' ? (text) => text.toLowerCase() : (text) => text;
  if (sameCase(value).startsWith(`${sameCase(root)}/`)) return value.slice(root.length + 1);
  return null;
}

/**
 * The absolute path of a program, found on PATH and never in the reviewed
 * checkout (1.13.0). Windows looks in the current directory first, so a bare
 * `ruff` launched with the checkout as its working directory would run a
 * `ruff.exe` committed in the branch. A name with a path separator is a path
 * the caller chose and is returned as it is.
 */
export async function resolveExecutable(name, { env = process.env, exclude = [], platform = process.platform } = {}) {
  if (/[\\/]/.test(name)) return name;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? '';
  const separator = platform === 'win32' ? ';' : ':';
  const extensions = platform === 'win32'
    ? (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((extension) => extension.toLowerCase())
      // Batch shims cannot be started without a shell; only programs count.
      .filter((extension) => extension === '.exe' || extension === '.com')
    : [''];
  const excluded = await Promise.all(exclude.filter(Boolean).map(async (directory) => {
    const resolved = await realpath(directory).catch(() => path.resolve(directory));
    return platform === 'win32' ? resolved.toLowerCase() : resolved;
  }));
  // Where the package managers Sentinel installs with put programs, also when
  // a long-running watcher started before they were added to PATH.
  const managed = platform === 'win32'
    // User-scope and machine-scope winget installs.
    ? [env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links') : null,
      env.ProgramFiles ? path.join(env.ProgramFiles, 'WinGet', 'Links') : null]
    : platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [];
  for (const directory of [...pathValue.split(separator), ...managed.filter(Boolean)]) {
    if (!directory || directory === '.' || !path.isAbsolute(directory)) continue;
    const real = await realpath(directory).catch(() => null);
    if (!real) continue;
    const comparable = platform === 'win32' ? real.toLowerCase() : real;
    if (excluded.some((root) => comparable === root || comparable.startsWith(`${root}${path.sep}`))) continue;
    for (const extension of extensions) {
      const candidate = path.join(real, platform === 'win32' && name.toLowerCase().endsWith(extension) ? name : `${name}${extension}`);
      const info = await stat(candidate).catch(() => null);
      if (info?.isFile()) return candidate;
      // A Windows app execution alias (winget in WindowsApps) cannot be
      // stat'ed, but it is listed in its directory and starts normally.
      if (!info && platform === 'win32' && /[\\/]windowsapps$/i.test(real)) {
        const listed = await readdir(real).catch(() => []);
        if (listed.some((entry) => entry.toLowerCase() === path.basename(candidate).toLowerCase())) return candidate;
      }
    }
  }
  return null;
}

/**
 * Maps a tool's path for a file to the checkout-relative path, through the
 * spellings the same directory can have (a Windows 8.3 short name, a macOS
 * /var symlink): both the checkout and an absolute file are compared by
 * their resolved real paths.
 */
async function checkoutRelativizer(checkout) {
  const roots = [...new Set([checkout, await realpathNative(checkout).catch(() => checkout)])];
  return async (file) => {
    for (const root of roots) {
      const relative = checkoutRelative(file, root);
      if (relative) return relative;
    }
    const real = await realpathNative(file).catch(() => null);
    if (!real) return null;
    for (const root of roots) {
      const relative = checkoutRelative(real, root);
      if (relative) return relative;
    }
    return null;
  };
}

/** Shape a linter hit as a deterministic finding (see lint.mjs). */
export function toolFinding({ source, rule, title, file, line, detail, priority }) {
  return {
    candidate_id: `${source}-0`,
    title: `${rule}: ${title}`,
    priority,
    file: normalize(file),
    line: Number.isInteger(line) && line >= 1 ? line : null,
    disposition: 'verified',
    reason: detail || title,
    scenario: `Reported by ${source} on a line this diff added.`,
    proposed_test: `Run ${source} on the file; the hit disappears once fixed.`,
    source,
    adjudicatedDisposition: 'deterministic',
  };
}

/**
 * The files that are regular files at head, bounded, and how many were left
 * out: past the bound, or not a regular file (a symlink is never followed).
 * A file deleted at head is not left out; it has nothing to analyze.
 */
async function analyzable(checkout, files, max = MAX_LANE_FILES) {
  const present = [];
  let notRegular = 0;
  for (const file of files) {
    const info = await lstat(path.join(checkout, file)).catch(() => null);
    if (info?.isFile()) present.push(file);
    else if (info) notRegular += 1;
  }
  return { files: present.slice(0, max), omitted: notRegular + Math.max(0, present.length - max) };
}

async function firstLine(target) {
  try {
    const handle = await open(target, 'r');
    try {
      const buffer = Buffer.alloc(128);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.toString('utf8', 0, bytesRead).split(/\r?\n/)[0];
    } finally {
      await handle.close();
    }
  } catch {
    return '';
  }
}

/**
 * Run one tool and turn what can go wrong into a lane note. Only a
 * process-tree cleanup failure rejects: it must reach the gate's fence.
 */
async function runTool(lane, command, args, { cwd, run, timeoutMs, env, input, exclude = [cwd], resolve }) {
  const executable = await (resolve ?? resolveExecutable)(command, { env, exclude });
  if (!executable) {
    return { lane: { lane, status: 'unavailable', note: `${command} is not installed on this host`, findings: [] } };
  }
  try {
    return {
      result: await run(executable, args, {
        cwd, env, timeoutMs, input, allowFailure: true, maxOutputBytes: MAX_LANE_OUTPUT_BYTES,
      }),
    };
  } catch (error) {
    if (processTreeCleanupFailureCode(error)) throw error;
    if (error?.code === 'TIMEOUT') {
      return { lane: { lane, status: 'timeout', note: `${command} exceeded ${Math.round(timeoutMs / 1000)} seconds`, findings: [] } };
    }
    if (/ENOENT/.test(error?.message || '') || error?.code === 'ENOENT') {
      return { lane: { lane, status: 'unavailable', note: `${command} is not installed on this host`, findings: [] } };
    }
    return { lane: { lane, status: 'error', note: `${command} failed: ${String(error?.message || error).slice(0, 300)}`, findings: [] } };
  }
}

function finish(lane, findings, { total, files, omitted = 0, maxFindings = LIMITS.maxDeterministicFindings }) {
  // Blocking hits come first, so a bound never hides one behind advisories.
  const ordered = [...findings.filter((finding) => finding.priority !== 'P3'), ...findings.filter((finding) => finding.priority === 'P3')];
  const kept = ordered.slice(0, maxFindings);
  return {
    lane,
    status: 'ok',
    note: `${total} hit(s) in ${files} file(s); ${findings.length} on added lines${findings.length > kept.length ? ` (bounded to ${kept.length})` : ''}${omitted ? `; ${omitted} changed file(s) NOT analyzed (past the lane's bounds)` : ''}`,
    findings: kept,
  };
}

function exitedBadly(lane, command, result, okCodes) {
  if (okCodes.includes(result.code)) return null;
  const detail = String(result.stderr || result.stdout || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
  return { lane, status: 'error', note: `${command} exited with code ${result.code}${detail ? `: ${detail.slice(0, 400)}` : ''}`, findings: [] };
}

function parseJson(text) {
  try {
    return JSON.parse(String(text || '').trim() || 'null');
  } catch {
    return undefined;
  }
}

export async function runShellcheckLane({ checkout, files, patch, run = runProcess, env = process.env, timeoutMs = LIMITS.toolLaneTimeoutMs, resolve }) {
  const lane = 'shellcheck';
  const candidates = [];
  for (const file of (files || []).map(normalize)) {
    if (SHELL_EXTENSION.test(file)) candidates.push(file);
    else if (!/\.[^/]+$/.test(file.split('/').pop()) && SHELL_SHEBANG.test(await firstLine(path.join(checkout, file)))) candidates.push(file);
  }
  const { files: targets, omitted } = await analyzable(checkout, candidates);
  if (!targets.length) return { lane, status: 'skipped', note: 'no shell script changed', findings: [] };
  const { result, lane: failed } = await runTool(lane, 'shellcheck', ['-f', 'json1', '-S', 'warning', '--', ...targets], { cwd: checkout, run, timeoutMs, env, resolve });
  if (failed) return failed;
  const bad = exitedBadly(lane, 'shellcheck', result, [0, 1]);
  if (bad) return bad;
  const parsed = parseJson(result.stdout);
  if (!parsed || !Array.isArray(parsed.comments)) return { lane, status: 'error', note: 'shellcheck output could not be read', findings: [] };
  const added = addedLinesByFile(patch);
  const findings = parsed.comments
    .filter((hit) => added.get(normalize(hit.file))?.has(hit.line))
    .map((hit) => toolFinding({
      source: lane,
      rule: `SC${hit.code}`,
      title: hit.message,
      file: hit.file,
      line: hit.line,
      detail: `${hit.message} (https://www.shellcheck.net/wiki/SC${hit.code})`,
      priority: hit.level === 'error' ? 'P2' : 'P3',
    }));
  return finish(lane, findings, { total: parsed.comments.length, files: targets.length, omitted });
}

export async function runActionlintLane({ checkout, files, patch, run = runProcess, env = process.env, timeoutMs = LIMITS.toolLaneTimeoutMs, resolve }) {
  const lane = 'actionlint';
  const { files: targets, omitted } = await analyzable(checkout, (files || []).map(normalize).filter((file) => WORKFLOW_FILE.test(file)));
  if (!targets.length) return { lane, status: 'skipped', note: 'no GitHub workflow changed', findings: [] };
  // Its shellcheck and pyflakes integrations are off: run-step style noise
  // would bury the workflow errors this lane is for.
  const { result, lane: failed } = await runTool(lane, 'actionlint', ['-format', '{{json .}}', '-shellcheck=', '-pyflakes=', '-no-color', ...targets], { cwd: checkout, run, timeoutMs, env, resolve });
  if (failed) return failed;
  const bad = exitedBadly(lane, 'actionlint', result, [0, 1]);
  if (bad) return bad;
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) return { lane, status: 'error', note: 'actionlint output could not be read', findings: [] };
  const added = addedLinesByFile(patch);
  const findings = parsed
    .filter((hit) => added.get(normalize(hit.filepath))?.has(hit.line))
    .map((hit) => toolFinding({
      source: lane,
      rule: hit.kind || 'actionlint',
      title: hit.message,
      file: hit.filepath,
      line: hit.line,
      detail: hit.message,
      priority: hit.kind === 'deprecated-commands' ? 'P3' : 'P2',
    }));
  return finish(lane, findings, { total: parsed.length, files: targets.length, omitted });
}

export async function runRuffLane({ checkout, files, patch, run = runProcess, env = process.env, timeoutMs = LIMITS.toolLaneTimeoutMs, resolve }) {
  const lane = 'ruff';
  const { files: targets, omitted } = await analyzable(checkout, (files || []).map(normalize).filter((file) => PYTHON_FILE.test(file)));
  if (!targets.length) return { lane, status: 'skipped', note: 'no Python file changed', findings: [] };
  const { result, lane: failed } = await runTool(lane, 'ruff', ['check', '--output-format', 'json', '--no-cache', '--quiet', '--force-exclude', '--', ...targets], { cwd: checkout, run, timeoutMs, env, resolve });
  if (failed) return failed;
  const bad = exitedBadly(lane, 'ruff', result, [0, 1]);
  if (bad) return bad;
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) return { lane, status: 'error', note: 'ruff output could not be read', findings: [] };
  const added = addedLinesByFile(patch);
  const relative = await checkoutRelativizer(checkout);
  const findings = [];
  for (const hit of parsed) {
    const file = await relative(hit.filename);
    const line = hit.location?.row;
    if (!file || !added.get(file)?.has(line)) continue;
    // Syntax errors, undefined names and misplaced statements are defects;
    // the rest is style.
    const blocking = !hit.code || /^(?:E9|F63|F7|F82)/.test(hit.code);
    findings.push(toolFinding({
      source: lane,
      rule: hit.code || 'syntax-error',
      title: hit.message,
      file,
      line,
      detail: `${hit.message}${hit.url ? ` (${hit.url})` : ''}`,
      priority: blocking ? 'P2' : 'P3',
    }));
  }
  return finish(lane, findings, { total: parsed.length, files: targets.length, omitted });
}

/** At most `maxBytes` of a file, or null when it is larger. */
async function readAtMost(target, maxBytes) {
  const handle = await open(target, 'r');
  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return bytesRead > maxBytes ? null : buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

// Paths gitleaks would not scan as data: its built-in rules skip any path
// containing gitleaks.toml (v8.30), and it reads the root .gitleaks.toml as
// its configuration. Each such changed file is scanned under a numbered name
// in a directory whose name carries the scan's random part, so it can neither
// switch rules off, escape the scan, nor overwrite another copy. (The ignore
// file is read from --gitleaks-ignore-path, outside the copy.)
const GITLEAKS_CONTROL = /gitleaks\.toml/i;

/**
 * gitleaks over a copy of the changed text files, with its built-in rules
 * and `gitleaks:allow` comments ignored, so nothing in the reviewed branch
 * can switch it off; findings are redacted and the secret never reaches the
 * report. Files past the size bounds, binary files and symlinks are not
 * scanned, and the note says how many.
 */
export async function runGitleaksLane({ checkout, files, patch, run = runProcess, env = process.env, timeoutMs = LIMITS.toolLaneTimeoutMs, temporaryRoot = os.tmpdir(), resolve }) {
  const lane = 'gitleaks';
  const added = addedLinesByFile(patch);
  const deadline = Date.now() + timeoutMs;
  const withAdded = (files || []).map(normalize).filter((file) => added.get(file)?.size);
  const { files: targets, omitted: overCount } = await analyzable(checkout, withAdded, MAX_LANE_FILES * 5);
  if (!targets.length) return { lane, status: 'skipped', note: 'no added lines to scan', findings: [] };
  const scratch = await mkdtemp(path.join(temporaryRoot, 'rove-review-gitleaks-'));
  try {
    const source = path.join(scratch, 'source');
    const scannedAs = new Map();
    const controlDirectory = `.sentinel-control-${path.basename(scratch)}`;
    let total = 0;
    let skipped = overCount;
    for (const file of targets) {
      if (Date.now() > deadline) {
        return { lane, status: 'timeout', note: `preparing the gitleaks scan exceeded ${Math.round(timeoutMs / 1000)} seconds`, findings: [] };
      }
      const text = await readAtMost(path.join(checkout, file), Math.min(MAX_SCAN_FILE_BYTES, MAX_SCAN_TOTAL_BYTES - total)).catch(() => null);
      if (!text || text.includes(0)) {
        skipped += 1;
        continue;
      }
      const copy = GITLEAKS_CONTROL.test(file) ? `${controlDirectory}/${scannedAs.size}.scanned` : file;
      await mkdir(path.dirname(path.join(source, copy)), { recursive: true });
      await writeFile(path.join(source, copy), text);
      scannedAs.set(copy, file);
      total += text.length;
    }
    if (!scannedAs.size) return { lane, status: 'skipped', note: `no changed text file to scan (${skipped} past the bounds or binary)`, findings: [] };
    const report = path.join(scratch, 'report.json');
    const { GITLEAKS_CONFIG: _config, GITLEAKS_CONFIG_TOML: _toml, ...cleanEnv } = env;
    const { result, lane: failed } = await runTool(lane, 'gitleaks', [
      'dir', source, '--report-format', 'json', '--report-path', report, '--no-banner', '--no-color', '--exit-code', '0', '--redact',
      '--ignore-gitleaks-allow', '--gitleaks-ignore-path', scratch,
    ], { cwd: scratch, run, timeoutMs: Math.max(1000, deadline - Date.now()), env: cleanEnv, exclude: [checkout], resolve });
    if (failed) return failed;
    const bad = exitedBadly(lane, 'gitleaks', result, [0]);
    if (bad) return bad;
    const parsed = parseJson(await readFile(report, 'utf8').catch(() => ''));
    if (!Array.isArray(parsed)) return { lane, status: 'error', note: 'gitleaks report could not be read', findings: [] };
    const findings = [];
    for (const hit of parsed) {
      const scanned = normalize(path.relative(source, path.resolve(source, String(hit.File || ''))));
      const file = scannedAs.get(scanned) ?? scanned;
      if (!added.get(file)?.has(hit.StartLine)) continue;
      findings.push(toolFinding({
        source: lane,
        rule: hit.RuleID || 'secret',
        title: 'possible committed secret',
        file,
        line: hit.StartLine,
        // Never the secret itself: the rule and its description only.
        detail: `${String(hit.Description || 'A credential pattern matched').slice(0, 300)} Remove the value from the change and rotate it if it is real; a placeholder that matches should be made obviously fake.`,
        priority: TEST_PATH.test(file) ? 'P3' : 'P2',
      }));
    }
    return finish(lane, findings, { total: parsed.length, files: scannedAs.size, omitted: skipped });
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Parse a project command's output: `unix` is `path:line:col: message`
 * (eslint -f unix, ruff --output-format concise, many compilers); `tsc` is
 * `path(line,col): error TSnnnn: message`.
 */
export function parseCommandOutput(text, format) {
  const hits = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (format === 'tsc') {
      const match = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/.exec(line);
      if (match) hits.push({ file: match[1], line: Number(match[2]), severity: match[4], rule: match[5], message: match[6] });
      continue;
    }
    const match = /^(.+?):(\d+):(\d+):\s*(.*)$/.exec(line);
    if (!match) continue;
    const tag = /\[(Error|Warning)(?:\/([^\]]+))?\]\s*$/i.exec(match[4]);
    hits.push({
      file: match[1],
      line: Number(match[2]),
      severity: tag ? tag[1].toLowerCase() : 'error',
      rule: tag?.[2] || null,
      message: tag ? match[4].slice(0, tag.index).trim() : match[4],
    });
  }
  return hits;
}

/**
 * One project command from the installed policy, run in the review checkout.
 * `{files}` as an argument becomes the changed files the command's `files`
 * pattern selects; `node` is this Node.js.
 */
export async function runProjectCommandLane({ checkout, files, patch, command, run = runProcess, env = process.env, resolve }) {
  const lane = command.name;
  const pattern = command.files ? new RegExp(command.files) : null;
  const selected = (files || []).map(normalize).filter((file) => !pattern || pattern.test(file));
  if (pattern && !selected.length) return { lane, status: 'skipped', note: `no changed file matches ${command.files}`, findings: [] };
  // Every matching file is passed, up to the bound checked below.
  const { files: targets, omitted: leftOut } = await analyzable(checkout, selected, Number.MAX_SAFE_INTEGER);
  const usesFiles = command.run.includes('{files}');
  if (usesFiles && !targets.length) return { lane, status: 'skipped', note: 'the matching changed files are absent at head', findings: [] };
  if (usesFiles && targets.length > MAX_LANE_FILES) {
    return { lane, status: 'skipped', note: `${targets.length} matching files exceed the ${MAX_LANE_FILES}-file bound for {files}`, findings: [] };
  }
  const args = command.run.flatMap((arg) => (arg === '{files}' ? targets : [arg]));
  // `node` is this Node.js; another bare name is looked up on PATH, never in
  // the checkout; a path names a program the project chose.
  const executable = args[0] === 'node' ? process.execPath : args[0];
  const timeoutMs = (command.timeoutMinutes ?? 5) * 60 * 1000;
  const { result, lane: failed } = await runTool(lane, executable, args.slice(1), { cwd: checkout, run, timeoutMs, env, resolve });
  if (failed) return failed.status === 'unavailable' ? { ...failed, note: `${args[0]} could not be started` } : failed;
  const hits = parseCommandOutput(`${result.stdout}\n${result.stderr}`, command.format);
  if (result.code !== 0 && !hits.length) {
    const bad = exitedBadly(lane, args[0], result, []);
    return { ...bad, note: `${bad.note} (no located diagnostic)` };
  }
  const added = addedLinesByFile(patch);
  const relative = await checkoutRelativizer(checkout);
  const findings = [];
  for (const hit of hits) {
    const file = await relative(path.isAbsolute(hit.file) ? hit.file : path.join(checkout, hit.file));
    if (!file) continue;
    if ((command.scope ?? 'added-lines') === 'added-lines' && !added.get(file)?.has(hit.line)) continue;
    findings.push(toolFinding({
      source: lane,
      rule: hit.rule || lane,
      title: hit.message,
      file,
      line: hit.line,
      detail: hit.message,
      priority: hit.severity === 'error' ? 'P2' : 'P3',
    }));
  }
  return finish(lane, findings, { total: hits.length, files: usesFiles ? targets.length : selected.length, omitted: usesFiles ? leftOut : 0 });
}

/**
 * Give the review checkout the trusted checkout's node_modules for project
 * commands that need it, as a directory junction (a symbolic link elsewhere)
 * removed before the lanes return. Removing a checkout never follows it
 * (git worktree remove and fs.rm both delete the link, not its target), and
 * the link is removed explicitly first anyway.
 */
export async function linkNodeModules(checkout, repoRoot) {
  const link = path.join(checkout, 'node_modules');
  const target = path.join(repoRoot, 'node_modules');
  try {
    await access(target);
  } catch {
    return { linked: false, note: 'the trusted checkout has no node_modules', release: async () => {} };
  }
  try {
    await lstat(link);
    return { linked: false, note: 'the reviewed head already has node_modules', release: async () => {} };
  } catch {
    // Absent: link it.
  }
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  return {
    linked: true,
    note: null,
    release: async () => {
      await unlink(link).catch(async () => {
        const stat = await lstat(link).catch(() => null);
        if (stat?.isSymbolicLink()) await rm(link, { force: true });
      });
    },
  };
}

/**
 * Which linter lanes this host can run (for doctor): each built-in tool's
 * version, or why it is not available, and whether installed policy turned
 * it off. A missing tool is not an error: its lane reports a note.
 */
export async function detectLintTools({ config = {}, run = runProcess, env = process.env, resolve = resolveExecutable } = {}) {
  const versionArgs = { shellcheck: ['--version'], actionlint: ['-version'], gitleaks: ['version'], ruff: ['--version'] };
  const entries = await Promise.all(BUILTIN_TOOL_LANES.map(async (tool) => {
    if (config?.lintLanes?.[tool] === false) return [tool, 'turned off in installed policy'];
    const executable = await resolve(tool, { env });
    if (!executable) return [tool, 'not installed; its lane is skipped'];
    try {
      const result = await run(executable, versionArgs[tool], { env, timeoutMs: 15_000, allowFailure: true, maxOutputBytes: 64 * 1024 });
      const text = String(result.stdout || result.stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const version = text.find((line) => /\d+\.\d+/.test(line)) || text[0] || 'available';
      return [tool, result.code === 0 ? version : `exited with code ${result.code}`];
    } catch (error) {
      if (processTreeCleanupFailureCode(error)) throw error;
      return [tool, /ENOENT/.test(error?.message || '') ? 'not installed; its lane is skipped' : `unavailable: ${String(error?.message || error).slice(0, 200)}`];
    }
  }));
  return {
    ...Object.fromEntries(entries),
    ...(Array.isArray(config?.lintCommands) && config.lintCommands.length
      ? { projectCommands: config.lintCommands.map((command) => command.name) }
      : {}),
  };
}
