import { access, writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { checkModels } from '../modelCheck.mjs';
import { LIMITS } from '../constants.mjs';

describe('explicit model-access probes', () => {
  it('rejects oversized structured output and removes the probe directory', async () => {
    let directory = '';
    const runner = async (_command, args, options) => {
      directory = options.cwd;
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await writeFile(outputPath, JSON.stringify({ ok: true, extra: 'x'.repeat(LIMITS.maxProcessOutputBytes) }));
      return { code: 0, stdout: '', stderr: '' };
    };
    await expect(checkModels('repo', { selected: ['codex'], runner })).rejects.toThrow(/output exceeded/);
    await expect(access(directory)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('probes every model and effort a role can request, once each (1.13.0)', async () => {
    const calls: string[] = [];
    const runner = async (_command, args) => {
      calls.push(`${args[args.indexOf('--model') + 1]}/${args.find((arg: string) => arg.startsWith('model_reasoning_effort='))}`);
      const outputPath = args[args.indexOf('--output-last-message') + 1];
      await writeFile(outputPath, JSON.stringify({ ok: true }));
      return { code: 0, stdout: '', stderr: '' };
    };
    const config = { models: { codex: { effort: 'high', roles: { scout: { effort: 'medium' }, shard: { effort: 'high' } } } } };
    const checks = await checkModels('repo', { selected: ['codex'], runner, config });
    expect(checks.map((check) => check.effort)).toEqual(['medium', 'xhigh', 'high']);
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls).toEqual([
      'gpt-6.1-sol/model_reasoning_effort="medium"',
      'gpt-6.1-sol/model_reasoning_effort="xhigh"',
      'gpt-6.1-sol/model_reasoning_effort="high"',
    ]);
  });
});
