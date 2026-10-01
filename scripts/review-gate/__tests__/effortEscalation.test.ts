import { describe, expect, it, vi } from 'vitest';
import { runWithEffortEscalation, runReviewer } from '../providers.mjs';

const profile = { model: 'gpt-6.1-sol', effort: 'high', maxEffort: 'xhigh' };
describe('bounded model-requested escalation', () => {
  it('refuses empty findings when required context was not read', async () => {
    const run = vi.fn().mockResolvedValue({ review_complete: false, effort_request: null,
      summary: 'Tool host unavailable; nothing was assessed', candidates: [] });
    await expect(runWithEffortEscalation({ run, profile, bundle: {}, provider: 'codex', prompt: '' }))
      .rejects.toThrow(/incomplete review/);
    expect(run).toHaveBeenCalledTimes(1);
  });
  it('keeps the reviewer’s own account of an incomplete review, bounded and on one line', async () => {
    // Without it, rove #584's failed shards could not be diagnosed (1.11.2).
    const summary = `Read all eight shard parts.\nContext output was truncated. ${'x'.repeat(1_000)}`;
    const run = vi.fn().mockResolvedValue({ review_complete: false, effort_request: null, summary, candidates: [] });
    const error = await runWithEffortEscalation({ run, profile, bundle: {}, provider: 'codex', prompt: '' }).catch((e) => e);
    expect(error.message).toMatch(/^Provider reported an incomplete review; no PASS is permitted\. Reviewer's account: Read all eight shard parts\.\\nContext output was truncated\./);
    expect(error.message).not.toContain('\n');
    expect(error.message.length).toBeLessThan(600);
  });
  it('says what makes a review incomplete: an unread required read, never a spent verification budget', async () => {
    const run = vi.fn().mockResolvedValue({ review_complete: true, effort_request: null, summary: 'ok', candidates: [] });
    await runWithEffortEscalation({ run, profile, bundle: {}, provider: 'codex', prompt: 'assignment' });
    const prompt = run.mock.calls[0][1];
    expect(prompt).toContain('every required read the context lists');
    expect(prompt).toContain('blocked, failed or came back truncated');
    expect(prompt).toContain('does not make the review\nincomplete');
  });
  it('gives the ceiling pass the same completeness contract, assigned prior blockers included', async () => {
    const { COMPLETENESS_CONTRACT } = await import('../providers.mjs');
    const run = vi.fn().mockResolvedValueOnce({ review_complete: true, summary: 'p', effort_request: 'Deeper look', candidates: [] })
      .mockResolvedValueOnce({ review_complete: true, summary: 'final', effort_request: null, candidates: [] });
    await runWithEffortEscalation({ run, profile, bundle: {}, provider: 'codex', prompt: 'assignment' });
    expect(run.mock.calls[0][1]).toContain(COMPLETENESS_CONTRACT);
    expect(run.mock.calls[1][1]).toContain(COMPLETENESS_CONTRACT);
    // A prior blocker the reviewer could not re-verify must not vanish as fixed.
    expect(COMPLETENESS_CONTRACT).toContain('the file of every prior blocker assigned to you');
  });
  it('counts call budgets after the required reads, for every role that has one', async () => {
    const { hypothesisPrompt, reviewerPrompt, scoutPrompt, shardPrompt } = await import('../providers.mjs');
    const shard = { index: 0, kind: 'code', files: ['src/a.ts'], changedLines: 1, patch: '' };
    expect(shardPrompt({ provider: 'codex', contextPath: 'ctx.md', shard, shardPath: 's.diff' })).toContain('calls after the\nshard read and the required reads');
    expect(scoutPrompt({ provider: 'codex', contextPath: 'ctx.md', maxHypotheses: 3 })).toContain('calls beyond the required reads');
    expect(hypothesisPrompt({ provider: 'codex', contextPath: 'ctx.md', hypothesis: { title: 't', file: 'f', line: 1, lens: 'l', claim: 'c', why: 'w' } })).toContain('calls beyond the required reads');
    expect(reviewerPrompt({ provider: 'codex', roleIndex: 0, contextPath: 'ctx.md' })).toContain('calls beyond the required reads');
  });
  it('tells Codex on Windows which commands its sandbox can run', async () => {
    const { codexPrompt, CODEX_WINDOWS_SHELL_NOTE } = await import('../providers.mjs');
    expect(codexPrompt('assignment', 'win32')).toBe(`assignment\n\n${CODEX_WINDOWS_SHELL_NOTE}`);
    expect(codexPrompt('assignment', 'linux')).toBe('assignment');
    expect(CODEX_WINDOWS_SHELL_NOTE).toMatch(/Get-Content/);
    expect(CODEX_WINDOWS_SHELL_NOTE).toMatch(/git grep -n/);
  });
  it('requires an explicit completeness declaration', async () => {
    const run = vi.fn().mockResolvedValue({ effort_request: null, candidates: [] });
    await expect(runWithEffortEscalation({ run, profile, bundle: {}, provider: 'codex', prompt: '' }))
      .rejects.toThrow(/review_complete/);
  });
  it('replaces the provisional answer with one fresh deeper pass and records it', async () => {
    const bundle = { providerExecutions: [] };
    const run = vi.fn().mockResolvedValueOnce({ review_complete: true, summary: 'provisional', effort_request: 'Verify a difficult interleaving', candidates: [] })
      .mockResolvedValueOnce({ review_complete: true, summary: 'final', effort_request: null, candidates: [] });
    const result = await runWithEffortEscalation({ run, profile, bundle, provider: 'codex', prompt: 'original assignment' });
    expect(result.summary).toBe('final');
    expect(run.mock.calls.map(([settings]) => settings.effort)).toEqual(['high', 'xhigh']);
    expect(run.mock.calls[1][1]).toContain('original assignment');
    expect(bundle.providerExecutions).toMatchObject([
      { effort: 'high', status: 'requested-escalation' },
      { effort: 'xhigh', escalationReason: 'Verify a difficult interleaving', status: 'complete' },
    ]);
  });
  it('fails closed on a failed deeper pass or a repeated request', async () => {
    for (const second of [() => Promise.reject(new Error('quota exceeded')), () => ({ review_complete: true, effort_request: 'more' })]) {
      const run = vi.fn().mockResolvedValueOnce({ review_complete: true, effort_request: 'harder reasoning' }).mockImplementationOnce(second);
      await expect(runWithEffortEscalation({ run, profile, bundle: {}, provider: 'codex', prompt: '' })).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(2);
    }
  });
  it('rejects escalation at the installed ceiling and malformed requests', async () => {
    for (const request of ['harder', '', {}, 'x'.repeat(501)]) {
      const run = vi.fn().mockResolvedValue({ review_complete: true, effort_request: request });
      await expect(runWithEffortEscalation({ run, profile: { ...profile, maxEffort: 'high' }, bundle: {}, provider: 'codex', prompt: '' })).rejects.toThrow();
      expect(run).toHaveBeenCalledTimes(1);
    }
  });
  it('uses a frozen custom profile in the actual Claude argument vector', async () => {
    const runner = vi.fn(async () => ({ stdout: JSON.stringify({ structured_output: { review_complete: true, summary: 'done', candidates: [], effort_request: null } }) }));
    await runReviewer({ provider: 'claude', roleIndex: 0, checkout: 'checkout',
      bundle: { directory: 'context', contextPath: 'ctx.md', modelConfig: { models: { claude: { model: 'claude-sonnet-5-5', effort: 'medium', maxEffort: 'high' } } } }, runner });
    const args = runner.mock.calls[0][1];
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    expect(args[args.indexOf('--effort') + 1]).toBe('medium');
  });
});
