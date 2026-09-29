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
});
