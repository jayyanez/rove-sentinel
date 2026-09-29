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
