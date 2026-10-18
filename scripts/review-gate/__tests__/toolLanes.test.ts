import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { normalizeConfig } from '../config.mjs';
import { runDeterministicLanes } from '../lint.mjs';
import {
  checkoutRelative,
  parseCommandOutput,
  runActionlintLane,
  runGitleaksLane,
  runProjectCommandLane,
  runRuffLane,
  runShellcheckLane,
} from '../toolLanes.mjs';

if (process.platform === 'win32') vi.setConfig({ testTimeout: 30_000 });

const temporary: string[] = [];
const passthrough = async (name: string) => name;
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function checkoutWith(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rove-tool-lanes-'));
  temporary.push(root);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), text);
  }
  return root;
}

/** A patch that adds every line of each file. */
function addedPatch(files: Record<string, string>) {
  return Object.entries(files).map(([file, text]) => {
    const lines = text.replace(/\n$/, '').split('\n');
    return [`diff --git a/${file} b/${file}`, 'new file mode 100644', '--- /dev/null', `+++ b/${file}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join('\n');
  }).join('\n');
}

const installed = (tool: string) => {
  try {
    execFileSync(tool, ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

describe('linter lanes with a controlled tool (1.13.0)', () => {
  it('reports shellcheck hits on added lines only, an error as P2 and a warning as P3', async () => {
    const files = { 'scripts/run.sh': 'echo hi\nrm -rf $DIR/\n', 'scripts/old.sh': 'x\n', 'hooks/pre-push': '#!/usr/bin/env bash\necho $x\n', 'notes/readme': 'plain\n' };
    const checkout = await checkoutWith(files);
    const calls: string[][] = [];
    const run = vi.fn(async (_command: string, args: string[]) => {
      calls.push(args);
      return {
        code: 1,
        stdout: JSON.stringify({ comments: [
          { file: 'scripts/run.sh', line: 2, level: 'warning', code: 2115, message: 'Use "${var:?}"' },
          { file: 'scripts/run.sh', line: 9, level: 'error', code: 1000, message: 'not added' },
          { file: 'hooks/pre-push', line: 2, level: 'error', code: 2154, message: 'x is referenced but not assigned' },
        ] }),
        stderr: '',
      };
    });
    const patch = addedPatch({ 'scripts/run.sh': files['scripts/run.sh'], 'hooks/pre-push': files['hooks/pre-push'] });
    const lane = await runShellcheckLane({ checkout, files: ['scripts/run.sh', 'hooks/pre-push', 'notes/readme', 'gone.sh'], patch, run, resolve: passthrough });
    // An extensionless file with a shell shebang is a script; other files and deleted ones are not passed.
    expect(calls[0].slice(-2)).toEqual(['scripts/run.sh', 'hooks/pre-push']);
    expect(lane.status).toBe('ok');
    expect(lane.findings.map((finding: { title: string; priority: string; line: number }) => [finding.title, finding.priority, finding.line])).toEqual([
      ['SC2154: x is referenced but not assigned', 'P2', 2],
      ['SC2115: Use "${var:?}"', 'P3', 2],
    ]);
  });

  it('says a tool is not installed, and never turns that into a finding', async () => {
    const checkout = await checkoutWith({ 'a.py': 'x = 1\n' });
    const run = async () => {
      throw Object.assign(new Error('Could not start ruff: spawn ruff ENOENT'), { code: 'SPAWN_ERROR' });
    };
    expect(await runRuffLane({ checkout, files: ['a.py'], patch: addedPatch({ 'a.py': 'x = 1\n' }), run, resolve: passthrough })).toEqual({
      lane: 'ruff', status: 'unavailable', note: 'ruff is not installed on this host', findings: [],
    });
    const timeout = async () => {
      throw Object.assign(new Error('timed out'), { code: 'TIMEOUT' });
    };
    expect(await runRuffLane({ checkout, files: ['a.py'], patch: addedPatch({ 'a.py': 'x = 1\n' }), run: timeout, resolve: passthrough, timeoutMs: 1000 }))
      .toMatchObject({ status: 'timeout', findings: [] });
    // A process-tree cleanup failure must reach the gate's fence.
    const orphan = async () => {
      throw Object.assign(new Error('tree lost'), { code: 'ORPHANED_PROCESS_TREE' });
    };
    await expect(runRuffLane({ checkout, files: ['a.py'], patch: addedPatch({ 'a.py': 'x = 1\n' }), run: orphan, resolve: passthrough })).rejects.toMatchObject({ code: 'ORPHANED_PROCESS_TREE' });
  });

  it('maps ruff codes to priorities and reads its absolute paths', async () => {
    const files = { 'app/a.py': 'import os\nprint(undefined_name)\n' };
    const checkout = await checkoutWith(files);
    const run = async () => ({
      code: 1,
      stdout: JSON.stringify([
        { code: 'F401', message: '`os` imported but unused', filename: path.join(checkout, 'app', 'a.py'), location: { row: 1, column: 8 } },
        { code: 'F821', message: 'Undefined name `undefined_name`', filename: path.join(checkout, 'app', 'a.py'), location: { row: 2, column: 7 } },
        { code: 'F821', message: 'elsewhere', filename: path.join(os.tmpdir(), 'other.py'), location: { row: 1, column: 1 } },
      ]),
      stderr: '',
    });
    const lane = await runRuffLane({ checkout, files: ['app/a.py'], patch: addedPatch(files), run, resolve: passthrough });
    expect(lane.findings.map((finding: { title: string; priority: string }) => [finding.title, finding.priority])).toEqual([
      ['F821: Undefined name `undefined_name`', 'P2'],
      ['F401: `os` imported but unused', 'P3'],
    ]);
  });

  it('scans a copy for secrets, without the branch\'s gitleaks configuration or the caller\'s', async () => {
    const files = { 'src/k.js': 'const a = 1;\nconst token = "x";\n', 'tests/fixture.js': 'const token = "y";\n', '.gitleaks.toml': '[allowlist]\npaths = [".*"]\n' };
    const checkout = await checkoutWith(files);
    let seen: { args: string[]; env: Record<string, string>; copied: string[] } | null = null;
    const run = async (_command: string, args: string[], options: { env: Record<string, string> }) => {
      const source = args[1];
      const copied = (await import('node:fs')).readdirSync(source, { recursive: true }).map(String).map((file) => file.replace(/\\/g, '/')).sort();
      seen = { args, env: options.env, copied };
      await writeFile(args[args.indexOf('--report-path') + 1], JSON.stringify([
        { RuleID: 'github-pat', Description: 'GitHub token', File: 'src/k.js', StartLine: 2, Secret: 'REDACTED' },
        { RuleID: 'github-pat', Description: 'GitHub token', File: 'tests/fixture.js', StartLine: 1, Secret: 'REDACTED' },
      ]));
      return { code: 0, stdout: '', stderr: '' };
    };
    const lane = await runGitleaksLane({ checkout, files: Object.keys(files), patch: addedPatch(files), run, resolve: passthrough, env: { PATH: 'x', GITLEAKS_CONFIG: '/allow-all.toml' } });
    // The branch's gitleaks configuration is scanned as data under another
    // name, never read as configuration (1.13.0 gate review).
    // gitleaks skips any file named .gitleaks.toml, so the copy is renamed too.
    expect(seen!.copied.some((file) => file.endsWith('.gitleaks.toml'))).toBe(false);
    expect(seen!.copied.find((file) => file.endsWith('.scanned'))).toMatch(/^\.sentinel-control-rove-review-gitleaks-[^/]+\/\d+\.scanned$/);
    expect(seen!.copied.filter((file) => !file.startsWith('.sentinel-control-'))).toEqual(['src', 'src/k.js', 'tests', 'tests/fixture.js']);
    expect(seen!.env).toEqual({ PATH: 'x' });
    expect(seen!.args).toEqual(expect.arrayContaining(['--redact', '--ignore-gitleaks-allow', '--gitleaks-ignore-path']));
    expect(lane.findings.map((finding: { file: string; priority: string; reason: string }) => [finding.file, finding.priority])).toEqual([
      ['src/k.js', 'P2'],
      ['tests/fixture.js', 'P3'],
    ]);
    expect(JSON.stringify(lane)).not.toContain('REDACTED');
  });

  it('parses unix and tsc output and runs a project command over the files it selects', async () => {
    expect(parseCommandOutput('C:\\repo\\src\\a.ts:3:5: Unexpected any [Error/no-explicit-any]\nnoise\nsrc/b.ts:1:1: warn [Warning/x]', 'unix')).toEqual([
      { file: 'C:\\repo\\src\\a.ts', line: 3, severity: 'error', rule: 'no-explicit-any', message: 'Unexpected any' },
      { file: 'src/b.ts', line: 1, severity: 'warning', rule: 'x', message: 'warn' },
    ]);
    expect(parseCommandOutput("src/a.ts(10,5): error TS2322: Type 'string' is not assignable", 'tsc')).toEqual([
      { file: 'src/a.ts', line: 10, severity: 'error', rule: 'TS2322', message: "Type 'string' is not assignable" },
    ]);
    const files = { 'src/a.ts': 'const a: any = 1;\nexport {};\n', 'src/b.ts': 'x\n', 'docs/c.md': 'y\n' };
    const checkout = await checkoutWith(files);
    const runs: Array<{ command: string; args: string[] }> = [];
    const run = async (command: string, args: string[]) => {
      runs.push({ command, args });
      return { code: 1, stdout: `${path.join(checkout, 'src', 'a.ts')}:1:10: Unexpected any [Error/no-explicit-any]\nsrc/b.ts:7:1: old [Warning/x]\n`, stderr: '' };
    };
    const command = normalizeConfig({ lintCommands: [{ name: 'eslint', run: ['node', 'node_modules/eslint/bin/eslint.js', '-f', 'unix', '{files}'], format: 'unix', files: '\\.ts$' }] }).lintCommands[0];
    const lane = await runProjectCommandLane({ checkout, files: Object.keys(files), patch: addedPatch({ 'src/a.ts': files['src/a.ts'] }), command, run, resolve: passthrough });
    expect(runs[0].command).toBe(process.execPath);
    expect(runs[0].args).toEqual(['node_modules/eslint/bin/eslint.js', '-f', 'unix', 'src/a.ts', 'src/b.ts']);
    expect(lane.findings.map((finding: { title: string; file: string; priority: string }) => [finding.title, finding.file, finding.priority])).toEqual([
      ['no-explicit-any: Unexpected any', 'src/a.ts', 'P2'],
    ]);
    // A failing command with no located diagnostic is a note, not a pass.
    const broken = await runProjectCommandLane({
      checkout, files: ['src/a.ts'], patch: '', command, resolve: passthrough, run: async () => ({ code: 2, stdout: '', stderr: 'Cannot find module eslint' }),
    });
    expect(broken).toMatchObject({ status: 'error', findings: [] });
    expect(broken.note).toContain('Cannot find module eslint');
  });

  it('links the trusted node_modules for project commands and removes the link afterwards', async () => {
    const repoRoot = await checkoutWith({ 'node_modules/tool/index.js': 'keep\n' });
    const checkout = await checkoutWith({ 'src/a.ts': 'x\n' });
    let sawModules = false;
    const run = async (_command: string, _args: string[], options: { cwd: string }) => {
      sawModules = await access(path.join(options.cwd, 'node_modules', 'tool', 'index.js')).then(() => true, () => false);
      return { code: 0, stdout: '', stderr: '' };
    };
    const config = normalizeConfig({
      lintLanes: { shellcheck: false, actionlint: false, gitleaks: false, ruff: false },
      lintCommands: [{ name: 'tsc', run: ['node', 'node_modules/typescript/bin/tsc', '--noEmit'], format: 'tsc', nodeModules: true }],
    });
    const result = await runDeterministicLanes({ checkout, files: ['src/a.ts'], patch: '', run, config, repoRoot });
    expect(sawModules).toBe(true);
    await expect(access(path.join(checkout, 'node_modules'))).rejects.toThrow();
    expect(await readFile(path.join(repoRoot, 'node_modules', 'tool', 'index.js'), 'utf8')).toBe('keep\n');
    expect(result.lanes.find((lane: { lane: string }) => lane.lane === 'tsc')).toMatchObject({ status: 'ok' });
    expect(result.lanes.filter((lane: { status: string }) => lane.status === 'skipped').map((lane: { lane: string }) => lane.lane))
      .toEqual(expect.arrayContaining(['shellcheck', 'actionlint', 'gitleaks', 'ruff']));
  });

  it('validates lint configuration', () => {
    expect(() => normalizeConfig({ lintLanes: { eslint: false } })).toThrow(/Unknown lint lane: eslint/);
    expect(() => normalizeConfig({ lintLanes: { ruff: 'no' } })).toThrow(/must be true or false/);
    expect(() => normalizeConfig({ lintCommands: [{ name: 'Bad Name', run: ['x'], format: 'unix' }] })).toThrow(/lower-case/);
    expect(() => normalizeConfig({ lintCommands: [{ name: 'gitleaks', run: ['x'], format: 'unix' }] })).toThrow(/already used/);
    expect(() => normalizeConfig({ lintCommands: [{ name: 'a', run: [], format: 'unix' }] })).toThrow(/1 to 64/);
    expect(() => normalizeConfig({ lintCommands: [{ name: 'a', run: ['x'], format: 'json' }] })).toThrow(/unix or tsc/);
    expect(() => normalizeConfig({ lintCommands: [{ name: 'a', run: ['x'], format: 'unix', files: '(' }] })).toThrow(/not a valid regular expression/);
    expect(() => normalizeConfig({ lintCommands: [{ name: 'a', run: ['x'], format: 'unix', timeoutMinutes: 30 }] })).toThrow(/1 to 15/);
    // Omitted keys stay omitted, so an installed policy keeps its digest.
    expect(normalizeConfig({})).not.toHaveProperty('lintLanes');
    expect(normalizeConfig({})).not.toHaveProperty('lintCommands');
    expect(checkoutRelative('C:/x/repo/src/a.ts', 'C:/x/repo')).toBe('src/a.ts');
    expect(checkoutRelative('/elsewhere/a.ts', '/x/repo')).toBeNull();
  });
});

describe('linter lanes with the real tools, where installed (1.13.0)', () => {
  it.skipIf(!installed('shellcheck'))('shellcheck finds an unguarded rm on an added line', async () => {
    const files = { 'scripts/clean.sh': '#!/bin/sh\nrm -rf $DIR/\n' };
    const checkout = await checkoutWith(files);
    const lane = await runShellcheckLane({ checkout, files: Object.keys(files), patch: addedPatch(files) });
    expect(lane.findings.map((finding: { title: string }) => finding.title.split(':')[0])).toContain('SC2115');
  });

  it.skipIf(!installed('actionlint'))('actionlint finds a broken workflow expression', async () => {
    const files = { '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${{ github.event.foo }\n' };
    const checkout = await checkoutWith(files);
    const lane = await runActionlintLane({ checkout, files: Object.keys(files), patch: addedPatch(files) });
    expect(lane.findings).toEqual([expect.objectContaining({ priority: 'P2', line: 6, file: '.github/workflows/ci.yml' })]);
  });

  it.skipIf(!installed('gitleaks'))('gitleaks finds a token and keeps it out of the report', async () => {
    const token = ['ghp', 'R7mQ2xK9vLp4TzW8nB3cY6dF1hJ5sA0gE2uX'].join('_');
    const files = { 'src/config.js': `export const a = 1;\nexport const token = "${token}";\n` };
    const checkout = await checkoutWith(files);
    const lane = await runGitleaksLane({ checkout, files: Object.keys(files), patch: addedPatch(files) });
    expect(lane.findings).toEqual([expect.objectContaining({ priority: 'P2', line: 2, file: 'src/config.js' })]);
    expect(JSON.stringify(lane)).not.toContain(token);
  });

  it.skipIf(!installed('gitleaks'))('gitleaks finds a token in the own .gitleaks.toml of the branch and reports it there', async () => {
    const token = ['ghp', 'R7mQ2xK9vLp4TzW8nB3cY6dF1hJ5sA0gE2uX'].join('_');
    const files = { '.gitleaks.toml': `title = "x"\n# ${token}\n`, 'config/.gitleaks.toml': `# ${token}\n`, 'my-gitleaks.toml.bak': `# ${token}\n` };
    const checkout = await checkoutWith(files);
    const lane = await runGitleaksLane({ checkout, files: Object.keys(files), patch: addedPatch(files) });
    // gitleaks skips every path containing gitleaks.toml; each is scanned
    // under its own name and reported against its own path.
    expect(lane.findings.map((finding: { file: string; line: number }) => [finding.file, finding.line]).sort()).toEqual([
      ['.gitleaks.toml', 2], ['config/.gitleaks.toml', 1], ['my-gitleaks.toml.bak', 1],
    ]);
  });

  it.skipIf(!installed('ruff'))('ruff finds an undefined name', async () => {
    const files = { 'app/a.py': 'def f():\n    return undefined_name\n', 'pyproject.toml': '[tool.ruff]\n' };
    const checkout = await checkoutWith(files);
    const lane = await runRuffLane({ checkout, files: ['app/a.py'], patch: addedPatch({ 'app/a.py': files['app/a.py'] }) });
    expect(lane.findings).toEqual([expect.objectContaining({ priority: 'P2', line: 2, title: expect.stringContaining('F821') })]);
  });
});

describe('doctor reports the linter tools (1.13.0)', () => {
  it('names each tool\'s version, a missing tool, and one turned off', async () => {
    const { detectLintTools } = await import('../toolLanes.mjs');
    const run = async (command: string) => {
      if (command === 'gitleaks') throw Object.assign(new Error('Could not start gitleaks: spawn gitleaks ENOENT'), { code: 'SPAWN_ERROR' });
      return { code: 0, stdout: command === 'shellcheck' ? 'ShellCheck - shell script analysis tool\nversion: 0.11.0\n' : `${command} 1.2.3\n`, stderr: '' };
    };
    expect(await detectLintTools({ run, resolve: passthrough, config: normalizeConfig({ lintLanes: { ruff: false }, lintCommands: [{ name: 'tsc', run: ['node', 'x'], format: 'tsc' }] }) })).toEqual({
      shellcheck: 'version: 0.11.0',
      actionlint: 'actionlint 1.2.3',
      gitleaks: 'not installed; its lane is skipped',
      ruff: 'turned off in installed policy',
      projectCommands: ['tsc'],
    });
  });
});

describe('linter lanes after the 1.13.0 gate review', () => {
  it('never runs a tool from the reviewed checkout, whatever PATH and the working directory say', async () => {
    const { resolveExecutable } = await import('../toolLanes.mjs');
    const name = 'sentinel-fake-tool';
    const file = process.platform === 'win32' ? `${name}.exe` : name;
    const checkout = await checkoutWith({ [file]: 'planted' });
    const trusted = await checkoutWith({ [file]: 'installed' });
    const env = { PATH: [checkout, '.', trusted].join(process.platform === 'win32' ? ';' : ':'), PATHEXT: '.CMD;.EXE' };
    expect(await resolveExecutable(name, { env, exclude: [checkout] })).toBe(path.join(await (await import('node:fs/promises')).realpath(trusted), file));
    expect(await resolveExecutable(name, { env: { PATH: checkout }, exclude: [checkout] })).toBeNull();
    // A path the project chose is kept as it is.
    expect(await resolveExecutable('node_modules/.bin/tool', { env })).toBe('node_modules/.bin/tool');
    // A lane whose tool is found only in the checkout reports it missing.
    const files = { 'a.py': 'x = 1\n' };
    const lane = await runRuffLane({ checkout: await checkoutWith(files), files: ['a.py'], patch: addedPatch(files), env: { PATH: '' }, run: async () => { throw new Error('must not run'); } });
    expect(lane).toMatchObject({ status: 'unavailable', note: 'ruff is not installed on this host' });
  });

  it('reads a hit reported under another spelling of the checkout path', async () => {
    const real = await checkoutWith({ 'app/a.py': 'import os\n' });
    const alias = path.join(await mkdtemp(path.join(os.tmpdir(), 'rove-tool-alias-')), 'checkout');
    temporary.push(path.dirname(alias));
    await (await import('node:fs/promises')).symlink(real, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const run = async () => ({ code: 1, stdout: JSON.stringify([{ code: 'F401', message: 'unused', filename: path.join(real, 'app', 'a.py'), location: { row: 1, column: 1 } }]), stderr: '' });
    const lane = await runRuffLane({ checkout: alias, files: ['app/a.py'], patch: addedPatch({ 'app/a.py': 'import os\n' }), run, resolve: passthrough });
    expect(lane.findings).toEqual([expect.objectContaining({ file: 'app/a.py', line: 1 })]);
  });

  it('bounds what the secret scan reads and says what it left out', async () => {
    const big = 'x'.repeat(1024 * 1024 + 1);
    const files = { 'src/big.txt': big, 'src/ok.js': 'const a = 1;\n', 'src/bin.dat': 'a\u0000b\n' };
    const checkout = await checkoutWith(files);
    let copied: string[] = [];
    const run = async (_command: string, args: string[]) => {
      copied = (await import('node:fs')).readdirSync(args[1], { recursive: true }).map(String).map((file) => file.replace(/\\/g, '/'));
      await writeFile(args[args.indexOf('--report-path') + 1], '[]');
      return { code: 0, stdout: '', stderr: '' };
    };
    const lane = await runGitleaksLane({ checkout, files: Object.keys(files), patch: addedPatch({ 'src/big.txt': 'x\n', 'src/ok.js': files['src/ok.js'], 'src/bin.dat': 'a\n' }), run, resolve: passthrough });
    expect(copied.filter((file) => file.includes('.'))).toEqual(['src/ok.js']);
    expect(lane.note).toContain('2 changed file(s) NOT analyzed');
  });

  it('lets every lane settle before removing the node_modules link, then reports the cleanup failure', async () => {
    const repoRoot = await checkoutWith({ 'node_modules/tool/index.js': 'keep\n' });
    const checkout = await checkoutWith({ 'run.sh': 'echo hi\n', 'src/a.ts': 'x\n' });
    let modulesAtEnd = false;
    const run = async (command: string, _args: string[], options: { cwd: string }) => {
      if (command === 'shellcheck') throw Object.assign(new Error('tree lost'), { code: 'ORPHANED_PROCESS_TREE' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      modulesAtEnd = await access(path.join(options.cwd, 'node_modules', 'tool', 'index.js')).then(() => true, () => false);
      return { code: 0, stdout: '', stderr: '' };
    };
    const config = normalizeConfig({
      lintLanes: { actionlint: false, gitleaks: false, ruff: false },
      lintCommands: [{ name: 'tsc', run: ['node', 'x'], format: 'tsc', nodeModules: true }],
    });
    await expect(runDeterministicLanes({
      checkout, files: ['run.sh', 'src/a.ts'], patch: addedPatch({ 'run.sh': 'echo hi\n' }), run, config, repoRoot, resolve: passthrough,
    })).rejects.toMatchObject({ code: 'ORPHANED_PROCESS_TREE' });
    expect(modulesAtEnd).toBe(true);
    await expect(access(path.join(checkout, 'node_modules'))).rejects.toThrow();
  });
});

describe('linter lanes after the second gate round of 1.13.0', () => {
  it('scans the branch gitleaks configuration as data without overwriting a file of the same new name', async () => {
    const files = { '.gitleaks.toml': 'one\n', '.gitleaks.toml.sentinel-scanned': 'two\n' };
    const checkout = await checkoutWith(files);
    const contents: string[] = [];
    const run = async (_command: string, args: string[]) => {
      const fsSync = await import('node:fs');
      for (const file of fsSync.readdirSync(args[1], { recursive: true }).map(String)) {
        const full = path.join(args[1], file);
        if (fsSync.statSync(full).isFile()) contents.push(fsSync.readFileSync(full, 'utf8'));
      }
      await writeFile(args[args.indexOf('--report-path') + 1], '[]');
      return { code: 0, stdout: '', stderr: '' };
    };
    await runGitleaksLane({ checkout, files: Object.keys(files), patch: addedPatch(files), run, resolve: passthrough });
    expect(contents.sort()).toEqual(['one\n', 'two\n']);
  });

  it('counts a changed symlink as left out', async () => {
    const checkout = await checkoutWith({ 'scripts/real.sh': 'echo hi\n' });
    await (await import('node:fs/promises')).symlink(path.join(checkout, 'scripts', 'real.sh'), path.join(checkout, 'scripts', 'link.sh'), 'file').catch(() => null);
    const linked = await (await import('node:fs/promises')).lstat(path.join(checkout, 'scripts', 'link.sh')).then((info) => info.isSymbolicLink(), () => false);
    if (!linked) return; // Creating a file symlink needs a privilege some Windows hosts lack.
    const run = async () => ({ code: 0, stdout: JSON.stringify({ comments: [] }), stderr: '' });
    const lane = await runShellcheckLane({ checkout, files: ['scripts/real.sh', 'scripts/link.sh'], patch: addedPatch({ 'scripts/real.sh': 'echo hi\n' }), run, resolve: passthrough });
    expect(lane.note).toContain('1 changed file(s) NOT analyzed');
  });

  it('reports a cleanup failure over another lane failure', async () => {
    const { laneFailure } = await import('../lint.mjs');
    const plain = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const orphan = Object.assign(new Error('tree lost'), { code: 'ORPHANED_PROCESS_TREE' });
    expect(laneFailure([{ status: 'rejected', reason: plain }, { status: 'fulfilled', value: {} }, { status: 'rejected', reason: orphan }])).toBe(orphan);
    expect(laneFailure([{ status: 'rejected', reason: plain }])).toBe(plain);
    expect(laneFailure([{ status: 'fulfilled', value: {} }])).toBeNull();
  });
});
