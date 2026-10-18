import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runProcess } from './process.mjs';
import { hashText, stateRootFor } from './storage.mjs';
import { BUILTIN_TOOL_LANES, resolveExecutable } from './toolLanes.mjs';

// The linter lanes need tools Sentinel does not bundle (1.13.0). On a new
// machine Sentinel says which are missing and how to install them, and
// installs them itself when asked: with winget on Windows and Homebrew on
// macOS, from fixed package identifiers. Nothing is installed without the
// user's explicit yes (an interactive answer or --yes).

export const TOOL_PACKAGES = Object.freeze({
  shellcheck: { winget: 'koalaman.shellcheck', brew: 'shellcheck', url: 'https://github.com/koalaman/shellcheck#installing' },
  actionlint: { winget: 'rhysd.actionlint', brew: 'actionlint', url: 'https://github.com/rhysd/actionlint/blob/main/docs/install.md' },
  gitleaks: { winget: 'Gitleaks.Gitleaks', brew: 'gitleaks', url: 'https://github.com/gitleaks/gitleaks#installing' },
  ruff: { winget: 'astral-sh.ruff', brew: 'ruff', url: 'https://docs.astral.sh/ruff/installation/' },
});

/** The enabled built-in tools this machine does not have. */
export async function missingTools({ config = {}, env = process.env, resolve = resolveExecutable } = {}) {
  const missing = [];
  for (const tool of BUILTIN_TOOL_LANES) {
    if (config?.lintLanes?.[tool] === false) continue;
    if (!(await resolve(tool, { env }))) missing.push(tool);
  }
  return missing;
}

/** How to install `tools` here: the commands Sentinel can run, or instructions. */
export function installPlan(tools, platform = process.platform) {
  if (!tools.length) return { manager: null, commands: [], instructions: [] };
  if (platform === 'win32') {
    return {
      manager: 'winget',
      commands: tools.map((tool) => ({
        tool,
        program: 'winget',
        args: ['install', '--id', TOOL_PACKAGES[tool].winget, '--exact', '--silent', '--accept-package-agreements', '--accept-source-agreements', '--disable-interactivity'],
      })),
      instructions: [`winget install ${tools.map((tool) => TOOL_PACKAGES[tool].winget).join(' ')}`],
    };
  }
  if (platform === 'darwin') {
    return {
      manager: 'brew',
      commands: [{ tool: tools.join(', '), program: 'brew', args: ['install', ...tools.map((tool) => TOOL_PACKAGES[tool].brew)] }],
      instructions: [`brew install ${tools.map((tool) => TOOL_PACKAGES[tool].brew).join(' ')}`],
    };
  }
  return {
    manager: null,
    commands: [],
    instructions: tools.map((tool) => `${tool}: ${TOOL_PACKAGES[tool].url}`),
  };
}

/** The text that tells a user what is missing and how to get it. */
export function formatToolsNotice(missing, platform = process.platform) {
  if (!missing.length) return null;
  const plan = installPlan(missing, platform);
  return [
    `Rove Sentinel: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not installed on this machine, so ${missing.length === 1 ? 'its linter lane is' : 'their linter lanes are'} skipped in reviews.`,
    plan.manager
      ? `Install ${missing.length === 1 ? 'it' : 'them'} with Sentinel (asks before installing): npx --no-install rove-sentinel tools --install`
      : 'Install them from:',
    ...plan.instructions.map((line) => `  ${line}`),
  ].join('\n');
}

function noticeRecord(env = process.env) {
  // Beside every repository's state: one record per OS account.
  return path.join(path.dirname(stateRootFor('rove-sentinel-machine', { env })), 'tools-notice.json');
}

/**
 * The missing-tools notice the first time this machine runs a review with
 * that set of tools missing, else null. Shown again only when the missing
 * set changes; `doctor` and `tools` always show it.
 */
export async function firstUseToolsNotice({ config = {}, env = process.env, resolve = resolveExecutable, platform = process.platform, record = noticeRecord(env) } = {}) {
  const missing = await missingTools({ config, env, resolve });
  if (!missing.length) return null;
  const key = hashText(missing.join(','), 16);
  const seen = await readFile(record, 'utf8').then((text) => JSON.parse(text)?.key, () => null);
  if (seen === key) return null;
  await mkdir(path.dirname(record), { recursive: true });
  await writeFile(record, `${JSON.stringify({ key, missing, shownAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
  return formatToolsNotice(missing, platform);
}

/**
 * Install the missing tools with the platform's package manager. The caller
 * has the user's consent. Returns what happened to each tool, checked again
 * afterwards.
 */
export async function installTools({ config = {}, env = process.env, run = runProcess, resolve = resolveExecutable, platform = process.platform, progress = () => {} } = {}) {
  const missing = await missingTools({ config, env, resolve });
  const plan = installPlan(missing, platform);
  if (!missing.length) return { installed: [], failed: [], missing: [], note: 'every linter tool is already installed' };
  if (!plan.manager) return { installed: [], failed: [], missing, note: 'no supported package manager on this platform; install them by hand', instructions: plan.instructions };
  const manager = await resolve(plan.manager, { env });
  if (!manager) return { installed: [], failed: [], missing, note: `${plan.manager} is not available on this machine`, instructions: plan.instructions };
  const failed = [];
  for (const command of plan.commands) {
    progress(`Installing ${command.tool} with ${plan.manager}...`);
    try {
      const result = await run(manager, command.args, { env, timeoutMs: 10 * 60 * 1000, allowFailure: true, maxOutputBytes: 1024 * 1024 });
      if (result.code !== 0) failed.push({ tool: command.tool, detail: String(result.stderr || result.stdout || '').trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 300) });
    } catch (error) {
      failed.push({ tool: command.tool, detail: String(error?.message || error).slice(0, 300) });
    }
  }
  const still = await missingTools({ config, env, resolve });
  return {
    installed: missing.filter((tool) => !still.includes(tool)),
    failed,
    missing: still,
    note: still.length ? `still missing: ${still.join(', ')}` : 'every linter tool is installed',
  };
}
