import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { profileFor } from './modelSettings.mjs';
import { buildClaudeArgs, buildCodexArgs, parseClaudeOutput } from './providers.mjs';
import { runProcess, subscriptionEnvironment } from './process.mjs';
import { removeTreeWithRetries } from './cleanup.mjs';

/** Explicit paid probe: subscription authentication alone does not prove model access. */
export async function checkModels(repoRoot, { config = {}, selected, runner = runProcess } = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'sentinel-model-check-'));
  const checks = [];
  let operationError;
  try {
    const schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    const schemaPath = path.join(directory, 'check.schema.json');
    await writeFile(schemaPath, JSON.stringify(schema), 'utf8');
    const env = subscriptionEnvironment({ ...process.env, ROVE_REVIEW_ALLOW_API_BILLING: undefined });
    delete env.ROVE_REVIEW_ALLOW_API_BILLING;
    for (const provider of selected) {
      const profile = profileFor(provider, 'Reviewer', config);
      for (const effort of new Set([profile.effort, profile.maxEffort])) {
        const outputPath = path.join(directory, `${provider}-${effort}.json`);
        const options = { checkout: directory, contextDirectory: directory, schema, schemaPath,
          outputPath, prompt: 'This is a model-access probe. Do not use tools or read files. Return exactly {"ok":true}.',
          ...profile, effort };
        const result = await runner(provider, provider === 'claude' ? buildClaudeArgs(options) : buildCodexArgs(options),
          { cwd: directory, env, timeoutMs: 60_000 });
        const value = provider === 'claude' ? parseClaudeOutput(result.stdout) : JSON.parse(await readFile(outputPath, 'utf8'));
        if (value?.ok !== true) throw new Error(`${provider} ${profile.model}/${effort} did not complete the model-access probe.`);
        checks.push({ provider, model: profile.model, effort, status: 'pass' });
      }
    }
    return checks;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try { await removeTreeWithRetries(directory); }
    catch (cleanupError) {
      throw new Error(`Model-check cleanup failed: ${cleanupError.message}${operationError ? `; original failure: ${operationError.message}` : ''}`, { cause: cleanupError });
    }
  }
}
