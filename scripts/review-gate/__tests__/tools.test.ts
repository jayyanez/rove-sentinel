import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { firstUseToolsNotice, formatToolsNotice, installPlan, installTools, missingTools } from '../tools.mjs';

const temporary: string[] = [];
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** A machine that has the programs listed. */
const machine = (...present: string[]) => async (name: string) => (present.includes(name) ? `/bin/${name}` : null);

describe('linter tools on a new machine (1.13.0)', () => {
  it('lists the enabled tools this machine lacks', async () => {
    expect(await missingTools({ resolve: machine('ruff') })).toEqual(['shellcheck', 'actionlint', 'gitleaks']);
    expect(await missingTools({ resolve: machine('ruff'), config: { lintLanes: { gitleaks: false } } })).toEqual(['shellcheck', 'actionlint']);
  });

  it('plans winget on Windows, Homebrew on macOS, and instructions elsewhere', () => {
    const windows = installPlan(['shellcheck', 'ruff'], 'win32');
    expect(windows.manager).toBe('winget');
    expect(windows.commands.map((command) => command.args.slice(0, 3))).toEqual([['install', '--id', 'koalaman.shellcheck'], ['install', '--id', 'astral-sh.ruff']]);
    expect(windows.instructions).toEqual(['winget install koalaman.shellcheck astral-sh.ruff']);
    expect(installPlan(['gitleaks'], 'darwin')).toMatchObject({ manager: 'brew', commands: [{ program: 'brew', args: ['install', 'gitleaks'] }] });
    expect(installPlan(['gitleaks'], 'linux')).toMatchObject({ manager: null, commands: [], instructions: [expect.stringContaining('gitleaks: https://')] });
    expect(formatToolsNotice(['actionlint'], 'win32')).toContain('npx --no-install rove-sentinel tools --install');
    expect(formatToolsNotice([], 'win32')).toBeNull();
  });

  it('tells a machine once per missing set', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'rove-tools-notice-'));
    temporary.push(directory);
    const record = path.join(directory, 'tools-notice.json');
    expect(await firstUseToolsNotice({ resolve: machine('ruff', 'gitleaks'), record, platform: 'win32' })).toContain('shellcheck, actionlint are not installed');
    expect(await firstUseToolsNotice({ resolve: machine('ruff', 'gitleaks'), record, platform: 'win32' })).toBeNull();
    // Another set is news again; nothing missing says nothing.
    expect(await firstUseToolsNotice({ resolve: machine('ruff'), record, platform: 'win32' })).toContain('gitleaks');
    expect(await firstUseToolsNotice({ resolve: machine('ruff', 'gitleaks', 'shellcheck', 'actionlint'), record, platform: 'win32' })).toBeNull();
    expect(JSON.parse(await readFile(record, 'utf8')).missing).toEqual(['shellcheck', 'actionlint', 'gitleaks']);
  });

  it('installs what is missing with the package manager and checks again', async () => {
    const present = ['winget', 'ruff'];
    const runs: string[][] = [];
    const run = async (_program: string, args: string[]) => {
      runs.push(args);
      const id = args[args.indexOf('--id') + 1];
      if (id === 'Gitleaks.Gitleaks') return { code: 1, stdout: '', stderr: 'No package found' };
      present.push({ 'koalaman.shellcheck': 'shellcheck', 'rhysd.actionlint': 'actionlint' }[id] as string);
      return { code: 0, stdout: 'Successfully installed', stderr: '' };
    };
    const resolve = async (name: string) => (present.includes(name) ? `/bin/${name}` : null);
    const result = await installTools({ run, resolve, platform: 'win32' });
    expect(runs.map((args) => args[args.indexOf('--id') + 1])).toEqual(['koalaman.shellcheck', 'rhysd.actionlint', 'Gitleaks.Gitleaks']);
    expect(result).toMatchObject({ installed: ['shellcheck', 'actionlint'], missing: ['gitleaks'], failed: [{ tool: 'gitleaks', detail: 'No package found' }] });
    expect(await installTools({ run, resolve: machine('ruff'), platform: 'win32' })).toMatchObject({ installed: [], note: 'winget is not available on this machine' });
    expect(await installTools({ run, resolve: machine(), platform: 'linux' })).toMatchObject({ installed: [], missing: ['shellcheck', 'actionlint', 'gitleaks', 'ruff'] });
  });
});
