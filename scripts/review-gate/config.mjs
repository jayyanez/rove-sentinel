import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { normalizeModels } from './modelSettings.mjs';

export const CONFIG_FILE = '.rove-sentinel.json';

function relativeFile(value, label) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes(':') ||
      value.startsWith('/') || value.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label} must be a repository-relative path using forward slashes.`);
  }
  return value;
}

/** Only installation reads repository configuration; reviews use its frozen snapshot. */
export function normalizeConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Sentinel configuration must be an object.');
  const allowed = ['schemaVersion', 'charter', 'lessons', 'guiEvidence', 'clippy', 'trustedAuthors', 'providers', 'models', 'lintLanes', 'lintCommands', 'maxShards'];
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new Error(`Unknown Sentinel configuration key: ${key}`);
  }
  if (input.schemaVersion !== undefined && input.schemaVersion !== 1) throw new Error('Unsupported Sentinel configuration schema.');
  const guiEvidence = input.guiEvidence ?? 'none';
  if (!['none', 'rove'].includes(guiEvidence)) throw new Error('guiEvidence must be none or rove.');
  const clippy = input.clippy ?? false;
  if (typeof clippy !== 'boolean') throw new Error('clippy must be a boolean.');
  const trustedAuthors = input.trustedAuthors ?? [];
  if (input.providers !== undefined && !['auto', 'both', 'claude', 'codex'].includes(input.providers)) {
    throw new Error('providers must be auto, both, claude, or codex.');
  }
  if (!Array.isArray(trustedAuthors) || trustedAuthors.length > 100 ||
      trustedAuthors.some((name) => typeof name !== 'string' || !/^[a-zA-Z0-9-]+(?:\[bot\])?$/.test(name))) {
    throw new Error('trustedAuthors must contain at most 100 GitHub logins.');
  }
  return {
    schemaVersion: 1,
    charter: input.charter == null ? null : relativeFile(input.charter, 'charter'),
    lessons: input.lessons == null ? null : relativeFile(input.lessons, 'lessons'),
    guiEvidence,
    clippy,
    trustedAuthors: [...new Set(trustedAuthors.map((name) => name.toLowerCase()))].sort(),
    // Omitted new fields stay omitted so an existing installed policy remains
    // reproducible. Engine defaults are bound separately by GATE_VERSION.
    ...(input.providers !== undefined ? { providers: input.providers } : {}),
    ...(input.models !== undefined ? { models: normalizeModels(input.models) } : {}),
    ...(input.lintLanes !== undefined ? { lintLanes: normalizeLintLanes(input.lintLanes) } : {}),
    ...(input.maxShards !== undefined ? { maxShards: normalizeMaxShards(input.maxShards) } : {}),
    ...(input.lintCommands !== undefined ? { lintCommands: normalizeLintCommands(input.lintCommands) } : {}),
  };
}

/**
 * The most shards one round of a large change may have (1.14.0): depth
 * against time. 8 keeps the behavior before 1.14.0; every 8 more add a wave
 * of reviewers.
 */
function normalizeMaxShards(value) {
  if (!Number.isInteger(value) || value < 8 || value > 128) throw new Error('maxShards must be a whole number from 8 to 128.');
  return value;
}

const LINT_LANES = ['shellcheck', 'actionlint', 'gitleaks', 'ruff'];

/** Built-in linter lanes a project turns off (1.13.0); every lane is on by default. */
function normalizeLintLanes(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('lintLanes must be an object.');
  for (const [lane, enabled] of Object.entries(input)) {
    if (!LINT_LANES.includes(lane)) throw new Error(`Unknown lint lane: ${lane}. Expected one of ${LINT_LANES.join(', ')}.`);
    if (typeof enabled !== 'boolean') throw new Error(`lintLanes.${lane} must be true or false.`);
  }
  return Object.fromEntries(LINT_LANES.filter((lane) => lane in input).map((lane) => [lane, input[lane]]));
}

/**
 * Project lint commands (1.13.0). They execute the project's toolchain and
 * configuration from the reviewed head, so only installed (trusted) policy
 * can list them.
 */
function normalizeLintCommands(input) {
  if (!Array.isArray(input) || input.length > 8) throw new Error('lintCommands must be a list of at most 8 commands.');
  const names = new Set();
  return input.map((command, index) => {
    const label = `lintCommands[${index}]`;
    if (!command || typeof command !== 'object' || Array.isArray(command)) throw new Error(`${label} must be an object.`);
    for (const key of Object.keys(command)) {
      if (!['name', 'run', 'format', 'files', 'scope', 'timeoutMinutes', 'nodeModules'].includes(key)) throw new Error(`Unknown ${label} setting: ${key}`);
    }
    if (typeof command.name !== 'string' || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(command.name)) throw new Error(`${label}.name must be lower-case letters, digits and dashes.`);
    if (['markdownlint', 'clippy', ...LINT_LANES].includes(command.name) || names.has(command.name)) throw new Error(`${label}.name ${command.name} is already used.`);
    names.add(command.name);
    if (!Array.isArray(command.run) || !command.run.length || command.run.length > 64 ||
        command.run.some((arg) => typeof arg !== 'string' || !arg || arg.length > 500)) {
      throw new Error(`${label}.run must be a list of 1 to 64 non-empty strings: the program and its arguments.`);
    }
    if (!['unix', 'tsc'].includes(command.format)) throw new Error(`${label}.format must be unix or tsc.`);
    if (command.files !== undefined) {
      if (typeof command.files !== 'string' || !command.files || command.files.length > 200) throw new Error(`${label}.files must be a regular expression of at most 200 characters.`);
      try {
        new RegExp(command.files);
      } catch (error) {
        throw new Error(`${label}.files is not a valid regular expression: ${error.message}`);
      }
    }
    if (command.scope !== undefined && !['added-lines', 'all'].includes(command.scope)) throw new Error(`${label}.scope must be added-lines or all.`);
    if (command.timeoutMinutes !== undefined && (!Number.isInteger(command.timeoutMinutes) || command.timeoutMinutes < 1 || command.timeoutMinutes > 15)) {
      throw new Error(`${label}.timeoutMinutes must be a whole number from 1 to 15.`);
    }
    if (command.nodeModules !== undefined && typeof command.nodeModules !== 'boolean') throw new Error(`${label}.nodeModules must be true or false.`);
    return {
      name: command.name,
      run: [...command.run],
      format: command.format,
      ...(command.files !== undefined ? { files: command.files } : {}),
      scope: command.scope ?? 'added-lines',
      timeoutMinutes: command.timeoutMinutes ?? 5,
      nodeModules: command.nodeModules ?? false,
    };
  });
}

export async function readConfig(repoRoot) {
  try {
    return normalizeConfig(JSON.parse(await readFile(path.join(repoRoot, CONFIG_FILE), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeConfig();
    throw error;
  }
}
