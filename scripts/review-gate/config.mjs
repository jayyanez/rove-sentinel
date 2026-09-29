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
  const allowed = ['schemaVersion', 'charter', 'lessons', 'guiEvidence', 'clippy', 'trustedAuthors', 'providers', 'models'];
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
  };
}

export async function readConfig(repoRoot) {
  try {
    return normalizeConfig(JSON.parse(await readFile(path.join(repoRoot, CONFIG_FILE), 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return normalizeConfig();
    throw error;
  }
}
