import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { LIMITS } from '../constants.mjs';
import { settleReviewersWithRetry } from '../gate.mjs';
import { runReviewer } from '../providers.mjs';
import { ensureState } from '../storage.mjs';
import { detectSubscriptions } from '../subscriptions.mjs';
import {
  ProviderUsageLimitError,
  classifyUsageLimit,
  clearProviderHolds,
  describeProviderHold,
  heldProviders,
  isProviderUsageLimit,
  parseResetTime,
  providerHoldRecord,
  readProviderHolds,
  recordProviderHolds,
  usageLimitFromFailure,
} from '../usageLimits.mjs';

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporaryDirectory(prefix = 'sentinel-usage-limits-') {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

// 2026-11-06T12:00:00Z: 04:00 in Los Angeles (PST, after the November change).
const now = Date.UTC(2026, 10, 6, 12, 0, 0);
const HOUR = 3_600_000;

function exitFailure(stdout: string, stderr = '', code = 'NON_ZERO_EXIT') {
  return Object.assign(new Error(`exited with code 1`), { code, result: { code: 1, stdout, stderr } });
}

describe('usage-limit signatures', () => {
  it.each([
    'Claude AI usage limit reached|1794056400',
    "You've hit your weekly limit · resets 1am (America/Los_Angeles)",
    '5-hour limit reached ∙ resets 3pm',
    "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 days 3 hours 5 minutes.",
    '{"type":"error","message":"stream error","code":"usage_limit_reached","resets_in_seconds":7200}',
    "You're out of extra usage · resets Nov 9 at 10am (America/Los_Angeles)",
  ])('recognizes %s', (text) => {
    expect(classifyUsageLimit(text, { now })).toMatchObject({ message: expect.any(String) });
  });

  it.each([
    'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Rate limit exceeded"}}',
    "You've hit your rate limit; retrying in 5 seconds",
    'This change enforces a per-user usage limit in the billing module.',
    'Provider reported an incomplete review; no PASS is permitted.',
    '',
  ])('does not mistake %j for a usage limit', (text) => {
    expect(classifyUsageLimit(text, { now })).toBeNull();
  });
});

describe('reset times', () => {
  it('reads an epoch, a duration and a provider field', () => {
    const epoch = Math.floor(now / 1000) + 3 * 3600;
    expect(parseResetTime(`Claude AI usage limit reached|${epoch}`, { now })).toBe(epoch * 1000);
    expect(parseResetTime('try again in 2 days 3 hours 5 minutes.', { now })).toBe(now + 2 * 24 * HOUR + 3 * HOUR + 5 * 60_000);
    expect(parseResetTime('try again in 45 min', { now })).toBe(now + 45 * 60_000);
    expect(parseResetTime('{"code":"usage_limit_reached","resets_in_seconds":7200}', { now })).toBe(now + 2 * HOUR);
    expect(parseResetTime(`{"resets_at":${Math.floor(now / 1000) + 600}}`, { now })).toBe(now + 600_000);
  });

  it('reads a clock time in its named zone, or in local time, at its next occurrence', () => {
    // 1am in Los Angeles is 09:00 UTC; at 04:00 there it is today's 1am that passed.
    expect(parseResetTime('resets 1am (America/Los_Angeles)', { now })).toBe(Date.UTC(2026, 10, 7, 9, 0));
    expect(parseResetTime('5-hour limit reached ∙ resets 3pm (UTC)', { now })).toBe(Date.UTC(2026, 10, 6, 15, 0));
    expect(parseResetTime('resets 11am (UTC)', { now })).toBe(Date.UTC(2026, 10, 7, 11, 0));
    expect(parseResetTime('resets Nov 9 at 10am (America/Los_Angeles)', { now })).toBe(Date.UTC(2026, 10, 9, 18, 0));
    const today = new Date(now);
    let local = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 15, 5).getTime();
    if (local <= now) local = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1, 15, 5).getTime();
    expect(parseResetTime('or try again at 3:05 PM.', { now })).toBe(local);
  });

  it('reads a dated reset in the zone it names, never the host zone, and refuses an unknown zone', () => {
    // Gate review of c21404b: the zone was read from the wrong group, so the
    // host's zone was used and any zone name was accepted.
    expect(parseResetTime('resets Nov 9 at 10am (Asia/Tokyo)', { now })).toBe(Date.UTC(2026, 10, 9, 1, 0));
    expect(parseResetTime('resets Nov 9, 10am (UTC)', { now })).toBe(Date.UTC(2026, 10, 9, 10, 0));
    expect(parseResetTime('resets Nov 9 at 10am (Mars/Olympus_Mons)', { now })).toBeNull();
  });

  it('gives null for what cannot be read or is past, and holds a far reset to the bound', () => {
    expect(parseResetTime('resets 1am (Mars/Olympus_Mons)', { now })).toBeNull();
    expect(parseResetTime('Claude AI usage limit reached|1000000000', { now })).toBeNull();
    expect(parseResetTime("You've hit your usage limit.", { now })).toBeNull();
    expect(parseResetTime('resets Nov 5 at 10am (UTC)', { now })).toBeNull();
    expect(parseResetTime('try again in 30 days', { now })).toBe(now + LIMITS.providerHoldMaxMs);
  });
});

describe('typed detection from a failed provider only', () => {
  const envelope = (result: string) => JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result });

  it('types a Claude failure from its is_error result and a Codex failure from its error line', () => {
    const epoch = Math.floor(now / 1000) + 3600;
    const claude = usageLimitFromFailure('claude', exitFailure(envelope(`Claude AI usage limit reached|${epoch}`)), { now });
    expect(claude).toBeInstanceOf(ProviderUsageLimitError);
    expect(claude).toMatchObject({ provider: 'claude', resetAt: epoch * 1000 });
    const codex = usageLimitFromFailure('codex', exitFailure('', [
      'OpenAI Codex v0.159.0 (research preview)',
      '[2026-11-06T12:00:00] ERROR: You\'ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again in 2 days 3 hours 5 minutes.',
    ].join('\n')), { now });
    expect(isProviderUsageLimit(codex)).toBe(true);
    expect(codex).toMatchObject({ provider: 'codex', resetAt: now + 2 * 24 * HOUR + 3 * HOUR + 5 * 60_000 });
    const event = usageLimitFromFailure('codex', exitFailure('{"type":"error","message":"limit","code":"usage_limit_reached","resets_in_seconds":60}'), { now });
    expect(event).toMatchObject({ provider: 'codex', resetAt: now + 60_000 });
  });

  it('ignores a timeout, reviewed text in a transcript and a different error', () => {
    expect(usageLimitFromFailure('claude', exitFailure(envelope('Claude AI usage limit reached|1794056400'), '', 'TIMEOUT'), { now })).toBeNull();
    expect(usageLimitFromFailure('codex', exitFailure('', [
      "+ERROR: You've hit your usage limit (a line of the diff under review)",
      "    ERROR: You've hit your usage limit (indented command output)",
      'ERROR: stream disconnected before completion',
    ].join('\n')), { now })).toBeNull();
    expect(usageLimitFromFailure('claude', exitFailure(envelope('Request timed out')), { now })).toBeNull();
  });
});

describe('provider runners', () => {
  const answer = (summary: string) => ({ review_complete: true, effort_request: null, summary, candidates: [] });

  it('raises a typed error for a Claude usage limit, whether its exit code is 1 or 0', async () => {
    const directory = await temporaryDirectory();
    const bundle = { directory, contextPath: path.join(directory, 'context.md') };
    const failed = vi.fn(async () => {
      throw exitFailure(JSON.stringify({ is_error: true, result: "You've hit your weekly limit · resets 1am (America/Los_Angeles)" }));
    });
    await expect(runReviewer({ provider: 'claude', roleIndex: 0, checkout: directory, bundle, runner: failed }))
      .rejects.toMatchObject({ code: 'PROVIDER_USAGE_LIMIT', provider: 'claude' });
    // A usage limit is never retried inside the escalation either.
    expect(failed).toHaveBeenCalledTimes(1);
    const zero = vi.fn(async () => ({ code: 0, stderr: '', stdout: JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1794056400' }) }));
    await expect(runReviewer({ provider: 'claude', roleIndex: 0, checkout: directory, bundle, runner: zero }))
      .rejects.toBeInstanceOf(ProviderUsageLimitError);
  });

  it('never classifies a completed review whose own text mentions a usage limit', async () => {
    const directory = await temporaryDirectory();
    const bundle = { directory, contextPath: path.join(directory, 'context.md') };
    const summary = "The diff adds the message \"You've hit your usage limit. Claude AI usage limit reached|1794056400\".";
    const runner = vi.fn(async () => ({ code: 0, stderr: "ERROR: You've hit your usage limit", stdout: JSON.stringify({ structured_output: answer(summary) }) }));
    await expect(runReviewer({ provider: 'claude', roleIndex: 0, checkout: directory, bundle, runner }))
      .resolves.toMatchObject({ summary });
    // Salvaged structured output after a non-zero exit is a completed review too.
    const salvaged = vi.fn(async () => {
      throw exitFailure(JSON.stringify({ is_error: true, result: 'Claude AI usage limit reached|1794056400', structured_output: answer('salvaged') }));
    });
    await expect(runReviewer({ provider: 'claude', roleIndex: 0, checkout: directory, bundle, runner: salvaged }))
      .resolves.toMatchObject({ summary: 'salvaged' });
  });

  it('raises a typed error for Codex from its error output when it leaves no answer', async () => {
    const directory = await temporaryDirectory();
    const bundle = { directory, contextPath: path.join(directory, 'context.md'), reviewerSchemaPath: path.join(directory, 'schema.json') };
    const stderr = "ERROR: You've hit your usage limit. Upgrade to Pro or try again in 3 hours.";
    const failed = vi.fn(async () => { throw exitFailure('', stderr); });
    await expect(runReviewer({ provider: 'codex', roleIndex: 0, checkout: directory, bundle, runner: failed }))
      .rejects.toMatchObject({ code: 'PROVIDER_USAGE_LIMIT', provider: 'codex' });
    const silent = vi.fn(async () => ({ code: 0, stdout: '', stderr }));
    await expect(runReviewer({ provider: 'codex', roleIndex: 0, checkout: directory, bundle, runner: silent }))
      .rejects.toMatchObject({ code: 'PROVIDER_USAGE_LIMIT', provider: 'codex' });
    // A completed Codex answer is read from its file, whatever its stderr says.
    const completed = vi.fn(async (_command, args: string[]) => {
      await writeFile(args[args.indexOf('--output-last-message') + 1], JSON.stringify(answer("Mentions: You've hit your usage limit")));
      return { code: 0, stdout: '', stderr };
    });
    await expect(runReviewer({ provider: 'codex', roleIndex: 0, checkout: directory, bundle, runner: completed }))
      .resolves.toMatchObject({ summary: "Mentions: You've hit your usage limit" });
  });

  it('classifies a Codex error event on standard output instead of salvaging it as an answer', async () => {
    // Gate review of c21404b: the event parsed as JSON and was returned as the
    // reviewer's answer, so the run failed for a missing review_complete.
    const directory = await temporaryDirectory();
    const bundle = { directory, contextPath: path.join(directory, 'context.md'), reviewerSchemaPath: path.join(directory, 'schema.json') };
    const event = JSON.stringify({ type: 'error', message: "You've hit your usage limit. Try again in 3 hours.", code: 'usage_limit_reached' });
    const runner = vi.fn(async () => { throw exitFailure(event, ''); });
    await expect(runReviewer({ provider: 'codex', roleIndex: 0, checkout: directory, bundle, runner }))
      .rejects.toMatchObject({ code: 'PROVIDER_USAGE_LIMIT', provider: 'codex' });
  });

  it('does not retry a reviewer that reported its usage limit', async () => {
    const task = vi.fn(async () => { throw new ProviderUsageLimitError('codex', { message: 'limit' }); });
    const [result] = await settleReviewersWithRetry([task]);
    expect(result).toMatchObject({ status: 'rejected', retried: false });
    expect(task).toHaveBeenCalledTimes(1);
  });
});

describe('the usage-limit record', () => {
  it('records, expires by itself, keeps the latest reset and is cleared by a provider that worked', async () => {
    const paths = await ensureState(await temporaryDirectory());
    await recordProviderHolds(paths, [
      { provider: 'codex', resetAt: null, message: 'x'.repeat(1000) },
      { provider: 'claude', resetAt: now + 5 * HOUR, message: "You've hit your weekly limit" },
      { provider: 'claude', resetAt: now + 2 * HOUR, message: 'earlier' },
    ], { now });
    const live = await readProviderHolds(paths, { now });
    expect(live.codex).toMatchObject({ resetAt: null, retryAfter: new Date(now + LIMITS.providerHoldReprobeMs).toISOString() });
    expect(live.codex.message).toHaveLength(LIMITS.providerHoldMessageChars);
    expect(live.claude).toMatchObject({ resetAt: new Date(now + 5 * HOUR).toISOString(), message: "You've hit your weekly limit" });
    // The unknown reset is re-probed after the window; the known one holds.
    expect(Object.keys(await readProviderHolds(paths, { now: now + LIMITS.providerHoldReprobeMs + 1 }))).toEqual(['claude']);
    expect(await readProviderHolds(paths, { now: now + 5 * HOUR + 1 })).toEqual({});
    await clearProviderHolds(paths, ['claude']);
    expect(Object.keys(await readProviderHolds(paths, { now }))).toEqual(['codex']);
    await clearProviderHolds(paths, ['codex']);
    await expect(readFile(paths.providerHolds, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reads a corrupt record as no record', async () => {
    const paths = await ensureState(await temporaryDirectory());
    await writeFile(paths.providerHolds, '{not json');
    expect(await readProviderHolds(paths, { now })).toEqual({});
    await writeFile(paths.providerHolds, JSON.stringify({ codex: { since: 'never' }, gemini: {} }));
    expect(await readProviderHolds(paths, { now })).toEqual({});
  });
});

describe('subscription selection with usage-limit records', () => {
  const env = { ANTHROPIC_API_KEY: 'do-not-use', OPENAI_API_KEY: 'do-not-use' };
  const probe = () => vi.fn(async (command: string, args: string[]) => ({
    code: 0,
    stderr: '',
    stdout: args[0] === '--version' ? `${command} 1.0` : command === 'claude' ? '{"loggedIn":true,"authMethod":"claude.ai"}' : 'Logged in using ChatGPT',
  }));
  const record = (hours: number | null) => ({
    since: new Date(now).toISOString(),
    resetAt: hours === null ? null : new Date(now + hours * HOUR).toISOString(),
    retryAfter: new Date(now + (hours ?? 1) * HOUR).toISOString(),
    message: 'limit',
  });

  it('leaves an exhausted provider out under auto, without probing it', async () => {
    const run = probe();
    const result = await detectSubscriptions('repo', { run, env, holds: { codex: record(96) } });
    expect(result.selected).toEqual(['claude']);
    expect(result.availability.codex).toMatchObject({ available: false, error: expect.stringMatching(/^codex usage limit reached; retry after 2026-11-10T12:00:00.000Z$/) });
    expect(run.mock.calls.every(([command]) => command === 'claude')).toBe(true);
  });

  it('names every reset time when no provider remains, and never falls back under an explicit requirement', async () => {
    await expect(detectSubscriptions('repo', { run: probe(), env, holds: { claude: record(2), codex: record(null) } }))
      .rejects.toThrow(/No review provider is available: claude usage limit reached; retry after 2026-11-06T14:00:00.000Z; codex usage limit reached; retry after 2026-11-06T13:00:00.000Z \(no readable reset time/);
    await expect(detectSubscriptions('repo', { mode: 'both', run: probe(), env, holds: { codex: record(96) } }))
      .rejects.toThrow(/Provider requirement both cannot be satisfied: codex usage limit reached; retry after 2026-11-10T12:00:00.000Z\. Sentinel does not fall back/);
    await expect(detectSubscriptions('repo', { mode: 'codex', run: probe(), env, holds: { codex: record(96) } }))
      .rejects.toThrow(/Provider requirement codex cannot be satisfied/);
    // A record for a provider the requirement does not name changes nothing.
    expect((await detectSubscriptions('repo', { mode: 'claude', run: probe(), env, holds: { codex: record(96) } })).selected).toEqual(['claude']);
  });
});

describe('failure holds', () => {
  const env = { ANTHROPIC_API_KEY: 'do-not-use', OPENAI_API_KEY: 'do-not-use' };
  const failure = { reason: 'provider-failure', since: new Date(now).toISOString(), resetAt: null, retryAfter: new Date(now + HOUR).toISOString(), message: 'timed out' };
  const limited = { ...failure, reason: 'usage-limit' };

  it('hold a provider out of auto only while another is free, and never refuse an explicit requirement', () => {
    expect(heldProviders('auto', ['claude', 'codex'], { codex: failure })).toEqual(['codex']);
    expect(heldProviders('auto', ['claude', 'codex'], { claude: failure, codex: failure })).toEqual([]);
    expect(heldProviders('auto', ['claude', 'codex'], { claude: limited, codex: failure })).toEqual(['claude']);
    expect(heldProviders('auto', ['codex'], { codex: failure })).toEqual([]);
    expect(heldProviders('codex', ['codex'], { codex: failure })).toEqual([]);
    expect(heldProviders('both', ['claude', 'codex'], { codex: limited })).toEqual(['codex']);
  });

  it('give a failure no reset, let a usage limit outrank it, and describe both', async () => {
    const paths = await ensureState(await temporaryDirectory());
    expect(providerHoldRecord({ reason: 'provider-failure', resetAt: now + 5 * HOUR, message: 'x' }, { now }))
      .toMatchObject({ reason: 'provider-failure', resetAt: null, retryAfter: new Date(now + LIMITS.providerHoldReprobeMs).toISOString() });
    await recordProviderHolds(paths, [
      { provider: 'codex', reason: 'provider-failure', message: 'timed out' },
      { provider: 'codex', reason: 'usage-limit', resetAt: now + 5 * HOUR, message: 'limit' },
    ], { now });
    const { codex } = await readProviderHolds(paths, { now });
    expect(codex).toMatchObject({ reason: 'usage-limit', message: 'limit' });
    expect(describeProviderHold('codex', codex)).toMatch(/^codex usage limit reached; retry after/);
    expect(describeProviderHold('codex', failure)).toMatch(/^codex failed a recent review and is held back; retry after/);
  });

  it('still selects a failure-held provider when it is the only one installed', async () => {
    const run = vi.fn(async (command: string, args: string[]) => {
      if (command === 'claude') throw new Error('ENOENT');
      return { code: 0, stderr: '', stdout: args[0] === '--version' ? 'codex 1.0' : 'Logged in using ChatGPT' };
    });
    expect((await detectSubscriptions('repo', { run, env, holds: { codex: failure } })).selected).toEqual(['codex']);
    // A restart's dropped provider is never probed.
    const both = vi.fn(async (command: string, args: string[]) => ({
      code: 0, stderr: '', stdout: args[0] === '--version' ? `${command} 1.0` : command === 'claude' ? '{"loggedIn":true,"authMethod":"claude.ai"}' : 'Logged in using ChatGPT',
    }));
    expect((await detectSubscriptions('repo', { run: both, env, exclude: ['codex'] })).selected).toEqual(['claude']);
    expect(both.mock.calls.every(([command]) => command === 'claude')).toBe(true);
  });
});
