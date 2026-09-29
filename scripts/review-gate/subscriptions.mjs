import { runProcess, subscriptionEnvironment, processTreeCleanupFailureCode } from './process.mjs';
import { PROVIDERS, selectProviders } from './modelSettings.mjs';

/** Probe native subscription authentication without a model call or API billing. */
export async function detectSubscriptions(repoRoot, { mode = 'auto', run = runProcess, env = process.env } = {}) {
  const safeEnv = subscriptionEnvironment({ ...env, ROVE_REVIEW_ALLOW_API_BILLING: undefined });
  delete safeEnv.ROVE_REVIEW_ALLOW_API_BILLING;
  const wanted = mode === 'claude' || mode === 'codex' ? [mode] : PROVIDERS;
  const availability = {};
  await Promise.all(wanted.map(async (provider) => {
    try {
      const version = await run(provider, ['--version'], { cwd: repoRoot, env: safeEnv, timeoutMs: 30_000, allowFailure: true });
      if (version.code !== 0) throw new Error(`${provider} version check failed.`);
      const auth = await run(provider, provider === 'claude' ? ['auth', 'status'] : ['login', 'status'],
        { cwd: repoRoot, env: safeEnv, timeoutMs: 30_000, allowFailure: true });
      if (auth.code !== 0) throw new Error(`${provider} authentication check failed.`);
      if (provider === 'claude') {
        let status;
        try { status = JSON.parse(auth.stdout); }
        catch { throw new Error('Claude Code authentication status returned invalid JSON.'); }
        if (!status || typeof status !== 'object' || Array.isArray(status) || typeof status.loggedIn !== 'boolean' || typeof status.authMethod !== 'string') {
          throw new Error('Claude Code authentication status returned an unexpected shape.');
        }
        if (!status.loggedIn) throw new Error('Claude Code is not authenticated.');
        if (status.authMethod !== 'claude.ai') throw new Error('Claude Code is not authenticated through a Claude subscription.');
      } else if (!/^Logged in using ChatGPT\s*$/im.test(`${auth.stdout || ''}\n${auth.stderr || ''}`)) {
        throw new Error('Codex is not authenticated through ChatGPT.');
      }
      const versionText = `${version.stdout || version.stderr || ''}`.trim().split(/\r?\n/)[0];
      availability[provider] = { available: true, version: versionText };
    } catch (error) {
      // An optional provider is not allowed to hide an unverified process tree.
      if (processTreeCleanupFailureCode(error)) throw error;
      availability[provider] = { available: false, error: error?.message || String(error) };
    }
  }));
  let selected;
  try { selected = selectProviders(mode, wanted.filter((provider) => availability[provider]?.available)); }
  catch (error) {
    const details = wanted.filter((provider) => !availability[provider]?.available)
      .map((provider) => availability[provider]?.error).join(' ');
    throw new Error(`${error.message} ${details}`.trim());
  }
  return { selected, availability };
}
