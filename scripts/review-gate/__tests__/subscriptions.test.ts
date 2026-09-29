import { describe, expect, it, vi } from 'vitest';
import { detectSubscriptions } from '../subscriptions.mjs';

function probe(available: string[], badAuth = '') {
  return vi.fn(async (command, args, options) => {
    expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.ROVE_REVIEW_ALLOW_API_BILLING).toBeUndefined();
    if (!available.includes(command)) throw new Error('ENOENT');
    return { code: 0, stderr: '', stdout: args[0] === '--version' ? `${command} 1.0`
      : command === 'claude' ? badAuth || '{"loggedIn":true,"authMethod":"claude.ai"}'
      : badAuth || 'Logged in using ChatGPT' };
  });
}

const env = { ANTHROPIC_API_KEY: 'do-not-use', OPENAI_API_KEY: 'do-not-use', ROVE_REVIEW_ALLOW_API_BILLING: '1' };
describe('available subscription providers', () => {
  it.each([['claude'], ['codex'], ['claude', 'codex']])('uses the installed authenticated set %j', async (...available) => {
    expect((await detectSubscriptions('repo', { run: probe(available), env })).selected).toEqual(available);
  });
  it('refuses neither and refuses an unsatisfied explicit requirement', async () => {
    await expect(detectSubscriptions('repo', { run: probe([]), env })).rejects.toThrow(/at least one/);
    await expect(detectSubscriptions('repo', { mode: 'both', run: probe(['codex']), env })).rejects.toThrow(/both/);
  });
  it('never probes a provider excluded by installed policy', async () => {
    const run = probe(['claude', 'codex']);
    expect((await detectSubscriptions('repo', { mode: 'codex', run, env })).selected).toEqual(['codex']);
    expect(run.mock.calls.every(([command]) => command === 'codex')).toBe(true);
  });
  it('does not certify API credentials, misleading text or malformed authentication', async () => {
    await expect(detectSubscriptions('repo', { run: probe(['claude'], '{"loggedIn":true,"authMethod":"api_key"}'), env })).rejects.toThrow(/subscription/);
    await expect(detectSubscriptions('repo', { run: probe(['codex'], 'Not logged in using ChatGPT'), env })).rejects.toThrow(/ChatGPT/);
    await expect(detectSubscriptions('repo', { run: probe(['claude'], '{}'), env })).rejects.toThrow(/unexpected shape/);
  });
  it('does not hide optional-provider process cleanup failures', async () => {
    const error = Object.assign(new Error('unverified process tree'), { code: 'PROCESS_TREE_CLEANUP_FAILED' });
    const run = vi.fn(async () => { throw error; });
    await expect(detectSubscriptions('repo', { run, env })).rejects.toBe(error);
  });
});
