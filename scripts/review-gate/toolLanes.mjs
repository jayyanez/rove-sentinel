import { access, mkdir, mkdtemp, open, readFile, rm, symlink, unlink, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LIMITS } from './constants.mjs';
import { processTreeCleanupFailureCode, runProcess } from './process.mjs';
import { addedLinesByFile } from './shards.mjs';

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

async function existing(checkout, files) {
  const present = [];
  for (const file of files) {
    try {
      await access(path.join(checkout, file));
      present.push(file);
    } catch {
      // Deleted at head: nothing to analyze.
    }
  }
  return present;
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
async function runTool(lane, command, args, { cwd, run, timeoutMs, env, input }) {
  try {
    return {
      result: await run(command, args, {
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

function finish(lane, findings, { total, files, maxFindings = LIMITS.maxDeterministicFindings }) {
  // Blocking hits come first, so a bound never hides one behind advisories.
  const ordered = [...findings.filter((finding) => finding.priority !== 'P3'), ...findings.filter((finding) => finding.priority === 'P3')];
  const bounded = ordered.slice(0, maxFindings);
  return {
    lane,
    status: 'ok',
    note: `${total} hit(s) in ${files} file(s); ${findings.length} on added lines${findings.length > bounded.length ? ` (bounded to ${bounded.length})` : ''}`,
    findings: bounded,
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

export async function runShellcheckLane({ checkout, files, patch, run = runProcess, env = process.env, timeoutMs = LIMITS.toolLaneTimeoutMs }) {
  const lane = 'shellcheck';
  const candidates = [];
  for (const file of (files || []).map(normalize)) {
    if (SHELL_EXTENSION.test(file)) candidates.push(file);
    else if (!/\.[^/]+$/.test(file.split('/').pop()) && SHELL_SHEBANG.test(await firstLine(path.join(checkout, file)))) candidates.push(file);
  }
  const targets = (await existing(checkout, candidates)).slice(0, MAX_LANE_FILES);
  if (!targets.length) return { lane, status: 'skipped', note: 'no shell script changed', findings: [] };
  const { result, lane: failed } = await runTool(lane, 'shellcheck', ['-f', 'json1', '-S', 'warning', '--', ...targets], { cwd: checkout, run, timeoutMs, env });
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
  return finish(lane, findings, { total: parsed.comments.length, files: targets.length });
}

export async function runActionlintLane({ checkout, files, patch, run = runProcess, env = process.env, timeoutMs = LIMITS.toolLaneTimeoutMs }) {
  const lane = 'actionlint';
  const targets = (await existing(checkout, (files || []).map(normalize).filter((file) => WORKFLOW_FILE.test(file)))).slice(0, MAX_LANE_FILES);
  if (!targets.length) return { lane, status: 'skipped', note: 'no GitHub workflow changed', findings: [] };
  // Its shellcheck and pyflakes integrations are off: run-step style noise
  // would bury the workflow errors this lane is for.
  const { result, lane: failed } = await runTool(lane, 'actionlint', ['-format', '{{json .}}', '-shellcheck=', '-pyflakes=', '-no-color', ...targets], { cwd: checkout, run, timeoutMs, env });
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
  return finish(lane, findings, { total: parsed.length, files: targets.length });
}

export async function runRuffLane({ checkout, files, patch, run = runProcess, env = process.env, timeoutMs = LIMITS.toolLaneTimeoutMs }) {
  const lane = 'ruff';
  const targets = (await existing(checkout, (files || []).map(normalize).filter((file) => PYTHON_FILE.test(file)))).slice(0, MAX_LANE_FILES);
  if (!targets.length) return { lane, status: 'skipped', note: 'no Python file changed', findings: [] };
  const { result, lane: failed } = await runTool(lane, 'ruff', ['check', '--output-format', 'json', '--no-cache', '--quiet', '--force-exclude', '--', ...targets], { cwd: checkout, run, timeoutMs, env });
  if (failed) return failed;
  const bad = exitedBadly(lane, 'ruff', result, [0, 1]);
  if (bad) return bad;
  const parsed = parseJson(result.stdout);
  if (!Array.isArray(parsed)) return { lane, status: 'error', note: 'ruff output could not be read', findings: [] };
  const added = addedLinesByFile(patch);
  const findings = [];
  for (const hit of parsed) {
    const file = checkoutRelative(hit.filename, checkout);
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
  return finish(lane, findings, { total: parsed.length, files: targets.length });
}

/**
 * gitleaks over a copy of the changed text files, so a configuration or an
 * ignore file in the reviewed branch cannot switch its rules off; findings
 * are redacted and the secret never reaches the report.
 */
export async function runGitleaksLane({ checkout, files, patch, run = runProcess, env = process.env, timeoutMs = LIMITS.toolLaneTimeoutMs, temporaryRoot = os.tmpdir() }) {
  const lane = 'gitleaks';
  const added = addedLinesByFile(patch);
  const targets = (await existing(checkout, (files || []).map(normalize)
    .filter((file) => added.get(file)?.size && !/(?:^|\/)\.gitleaks(?:\.toml|ignore)$/i.test(file)))).slice(0, MAX_LANE_FILES * 5);
  if (!targets.length) return { lane, status: 'skipped', note: 'no added lines to scan', findings: [] };
  const scratch = await mkdtemp(path.join(temporaryRoot, 'rove-review-gitleaks-'));
  try {
    const source = path.join(scratch, 'source');
    let total = 0;
    let copied = 0;
    for (const file of targets) {
      try {
        const text = await readFile(path.join(checkout, file));
        if (text.length > MAX_SCAN_FILE_BYTES || total + text.length > MAX_SCAN_TOTAL_BYTES || text.includes(0)) continue;
        await mkdir(path.dirname(path.join(source, file)), { recursive: true });
        await writeFile(path.join(source, file), text);
        total += text.length;
        copied += 1;
      } catch {
        // Unreadable at head: nothing to scan.
      }
    }
    if (!copied) return { lane, status: 'skipped', note: 'no changed text file to scan', findings: [] };
    const report = path.join(scratch, 'report.json');
    const { GITLEAKS_CONFIG: _config, GITLEAKS_CONFIG_TOML: _toml, ...cleanEnv } = env;
    const { result, lane: failed } = await runTool(lane, 'gitleaks', [
      'dir', source, '--report-format', 'json', '--report-path', report, '--no-banner', '--no-color', '--exit-code', '0', '--redact',
    ], { cwd: scratch, run, timeoutMs, env: cleanEnv });
    if (failed) return failed;
    const bad = exitedBadly(lane, 'gitleaks', result, [0]);
    if (bad) return bad;
    const parsed = parseJson(await readFile(report, 'utf8').catch(() => ''));
    if (!Array.isArray(parsed)) return { lane, status: 'error', note: 'gitleaks report could not be read', findings: [] };
    const findings = [];
    for (const hit of parsed) {
      const file = normalize(path.relative(source, path.resolve(source, String(hit.File || ''))));
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
    return finish(lane, findings, { total: parsed.length, files: copied });
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
export async function runProjectCommandLane({ checkout, files, patch, command, run = runProcess, env = process.env }) {
  const lane = command.name;
  const pattern = command.files ? new RegExp(command.files) : null;
  const selected = (files || []).map(normalize).filter((file) => !pattern || pattern.test(file));
  if (pattern && !selected.length) return { lane, status: 'skipped', note: `no changed file matches ${command.files}`, findings: [] };
  const targets = await existing(checkout, selected);
  const usesFiles = command.run.includes('{files}');
  if (usesFiles && !targets.length) return { lane, status: 'skipped', note: 'the matching changed files are absent at head', findings: [] };
  if (usesFiles && targets.length > MAX_LANE_FILES) {
    return { lane, status: 'skipped', note: `${targets.length} matching files exceed the ${MAX_LANE_FILES}-file bound for {files}`, findings: [] };
  }
  const args = command.run.flatMap((arg) => (arg === '{files}' ? targets : [arg]));
  const executable = args[0] === 'node' ? process.execPath : args[0];
  const timeoutMs = (command.timeoutMinutes ?? 5) * 60 * 1000;
  const { result, lane: failed } = await runTool(lane, executable, args.slice(1), { cwd: checkout, run, timeoutMs, env });
  if (failed) return failed.status === 'unavailable' ? { ...failed, note: `${args[0]} could not be started` } : failed;
  const hits = parseCommandOutput(`${result.stdout}\n${result.stderr}`, command.format);
  if (result.code !== 0 && !hits.length) {
    const bad = exitedBadly(lane, args[0], result, []);
    return { ...bad, note: `${bad.note} (no located diagnostic)` };
  }
  const added = addedLinesByFile(patch);
  const findings = [];
  for (const hit of hits) {
    const file = checkoutRelative(hit.file, checkout);
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
  return finish(lane, findings, { total: hits.length, files: usesFiles ? targets.length : selected.length });
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
export async function detectLintTools({ config = {}, run = runProcess, env = process.env } = {}) {
  const versionArgs = { shellcheck: ['--version'], actionlint: ['-version'], gitleaks: ['version'], ruff: ['--version'] };
  const entries = await Promise.all(BUILTIN_TOOL_LANES.map(async (tool) => {
    if (config?.lintLanes?.[tool] === false) return [tool, 'turned off in installed policy'];
    try {
      const result = await run(tool, versionArgs[tool], { env, timeoutMs: 15_000, allowFailure: true, maxOutputBytes: 64 * 1024 });
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
