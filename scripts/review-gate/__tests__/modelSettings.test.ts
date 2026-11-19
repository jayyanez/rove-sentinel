import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../config.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { PROVIDER_PROFILE } from '../constants.mjs';
import { reviewPlan } from '../risk.mjs';
import { validateModelClients } from '../modelSettings.mjs';

describe('project model profiles and provider requirements', () => {
  it('pins all default roles to the requested models at high effort', () => {
    for (const [role, profile] of Object.entries(PROVIDER_PROFILE)) {
      expect(profile.model).toBe(role.startsWith('claude') ? 'claude-opus-5-5' : 'gpt-6.2-sol');
      expect(profile.effort).toBe('high');
      expect(profile.maxEffort).toBe('xhigh');
    }
  });

  it('freezes custom settings in the installed policy and detects changes', () => {
    const config = normalizeConfig({ providers: 'codex', models: {
      codex: { model: 'gpt-6-sol', effort: 'medium', maxEffort: 'high' },
    } });
    const first = reviewPolicySnapshot({ charter: '# Rules', lessons: '', config });
    expect(reviewPolicySnapshot(first)).toEqual(first);
    expect(() => reviewPolicySnapshot({ ...first, config: { ...config, providers: 'both' } })).toThrow(/digest/);
    expect(() => reviewPolicySnapshot({ ...first, config: { ...config, models: {
      codex: { model: 'gpt-6-sol', effort: 'high', maxEffort: 'xhigh' },
    } } })).toThrow(/digest/);
  });

  it.each(['claude-opus-4-6', 'claude-sonnet-4-6'])('resolves a supported ceiling for %s when omitted', (model) => {
    expect(normalizeConfig({ models: { claude: { model, effort: 'high' } } }).models.claude)
      .toEqual({ model, effort: 'high', maxEffort: 'high' });
    expect(normalizeConfig({ models: { claude: { model, effort: 'max' } } }).models.claude)
      .toEqual({ model, effort: 'max', maxEffort: 'max' });
  });

  it.each([
    { providers: 'anything' }, { models: [] }, { models: { other: {} } },
    { models: { claude: { model: '--invalid' } } },
    { models: { codex: { effort: 'ultra' } } },
    { models: { claude: { effort: 'none' } } },
    { models: { codex: { effort: 'high', maxEffort: 'low' } } },
    { models: { codex: { model: 'gpt-6.1-sol', effort: 'none' } } },
    { models: { codex: { model: 'gpt-6.2-sol', effort: 'none' } } },
    { models: { codex: { model: 'gpt-6.2-sol', effort: 'minimal', maxEffort: 'minimal' } } },
    { models: { codex: { effort: 'minimal' } } },
    { models: { claude: { model: 'claude-opus-4-6', maxEffort: 'xhigh' } } },
    { models: { codex: { temperature: 0 } } },
  ])('rejects invalid or incompatible profile settings: %j', (config) => {
    expect(() => normalizeConfig(config)).toThrow();
  });

  it.each(['claude', 'codex'])('preserves high-risk roles with only %s available', (provider) => {
    const plan = reviewPlan('high', provider, { providers: [provider] });
    expect(plan.reviewers).toEqual([provider, provider, provider]);
    expect(plan.coordinator).toBe(provider);
    expect(plan.useScout).toBe(true);
  });
  it('refuses the measured incompatible Codex client before model work', () => {
    const pinned = normalizeConfig({ models: { codex: { model: 'gpt-6.1-sol' } } });
    const subscriptions = { selected: ['codex'], availability: { codex: { version: 'codex-cli 0.154.0' } } };
    expect(() => validateModelClients(pinned, subscriptions)).toThrow(/0.159.0 or later/);
    expect(() => validateModelClients({ models: { codex: { model: 'gpt-5.6-sol' } } }, subscriptions)).not.toThrow();
    expect(() => validateModelClients(pinned, { ...subscriptions, availability: { codex: { version: 'codex-cli 0.159.0' } } })).not.toThrow();
  });

  it('requires Codex 0.170.0 for the default GPT-6.2 Sol (1.20.0)', () => {
    // Codex 0.159.0 answers model_not_found for gpt-6.2-sol under a ChatGPT login.
    const codex = (version: string) => ({ selected: ['codex'], availability: { codex: { version: `codex-cli ${version}` } } });
    for (const version of ['0.159.0', '0.169.9']) {
      expect(() => validateModelClients({}, codex(version)))
        .toThrow(/codex 0\.170\.0 or later is required for gpt-6\.2-sol; detected /);
    }
    expect(() => validateModelClients({}, codex('0.170.0'))).not.toThrow();
    expect(() => validateModelClients({}, codex('0.171.2'))).not.toThrow();
    // A project that pins GPT-6.1 Sol keeps its own, older minimum.
    expect(() => validateModelClients(normalizeConfig({ models: { codex: { model: 'gpt-6.1-sol' } } }), codex('0.159.0'))).not.toThrow();
    // A role that names GPT-6.2 Sol needs the newer client even when the provider pins GPT-6.1 Sol.
    const role = normalizeConfig({ models: { codex: { model: 'gpt-6.1-sol', roles: { coordinator: { model: 'gpt-6.2-sol' } } } } });
    expect(() => validateModelClients(role, codex('0.165.0'))).toThrow(/0\.170\.0 or later is required for gpt-6\.2-sol/);
  });

  it('gives GPT-6.2 Sol the efforts its client lists, without none or minimal', () => {
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(normalizeConfig({ models: { codex: { model: 'gpt-6.2-sol', effort } } }).models.codex.effort).toBe(effort);
    }
    expect(normalizeConfig({ models: { codex: { effort: 'low' } } }).models.codex)
      .toEqual({ model: 'gpt-6.2-sol', effort: 'low', maxEffort: 'xhigh' });
    // A model Sentinel knows nothing of still leaves those efforts to its client.
    expect(normalizeConfig({ models: { codex: { model: 'gpt-6-sol', effort: 'minimal', maxEffort: 'high' } } }).models.codex.effort).toBe('minimal');
  });
});

describe('per-role model and effort (1.13.0)', () => {
  it('resolves a role against its provider and keeps only the roles a project names', async () => {
    const { modelSettings, profileFor, providerProfiles } = await import('../modelSettings.mjs');
    const config = normalizeConfig({
      models: {
        claude: { effort: 'high', roles: { scout: { effort: 'medium' }, coordinator: { effort: 'xhigh' } } },
        codex: { model: 'gpt-6.1-sol', roles: { hypothesis: { effort: 'low', maxEffort: 'high' } } },
      },
    });
    expect(config.models.claude.roles).toEqual({
      scout: { model: 'claude-opus-5-5', effort: 'medium', maxEffort: 'xhigh' },
      coordinator: { model: 'claude-opus-5-5', effort: 'xhigh', maxEffort: 'xhigh' },
    });
    expect(profileFor('claude', 'Scout', config)).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', maxEffort: 'xhigh', role: 'Scout' });
    expect(profileFor('claude', 'Shard', config)).toMatchObject({ effort: 'high', maxEffort: 'xhigh' });
    // The Claude budget and context settings stay the role's own.
    expect(profileFor('claude', 'Coordinator', config)).toMatchObject({ effort: 'xhigh', maxBudgetUsd: 6, autocompact: '200k' });
    expect(profileFor('codex', 'Hypothesis', config)).toMatchObject({ effort: 'low', maxEffort: 'high' });
    expect(profileFor('codex', 'Reviewer', config)).toMatchObject({ effort: 'high', maxEffort: 'xhigh' });
    expect(modelSettings(config).codex).toEqual({
      model: 'gpt-6.1-sol', effort: 'high', maxEffort: 'xhigh',
      roles: { hypothesis: { model: 'gpt-6.1-sol', effort: 'low', maxEffort: 'high' } },
    });
    // No roles named: the record is exactly what it was before roles existed.
    expect(modelSettings(normalizeConfig({ models: { claude: { effort: 'high' } } })).claude).toEqual({
      model: 'claude-opus-5-5', effort: 'high', maxEffort: 'xhigh',
    });
    expect(providerProfiles('claude', config)).toEqual([
      { model: 'claude-opus-5-5', effort: 'medium', maxEffort: 'xhigh' },
      { model: 'claude-opus-5-5', effort: 'high', maxEffort: 'xhigh' },
      { model: 'claude-opus-5-5', effort: 'xhigh', maxEffort: 'xhigh' },
    ]);
  });

  it('refuses unknown roles and settings, and binds role settings into the policy digest', () => {
    expect(() => normalizeConfig({ models: { claude: { roles: { coverage: { effort: 'low' } } } } })).toThrow(/Unknown claude role: coverage/);
    expect(() => normalizeConfig({ models: { claude: { roles: { scout: { budget: 'x' } } } } })).toThrow(/Unknown claude scout setting: budget/);
    expect(() => normalizeConfig({ models: { claude: { roles: { scout: { effort: 'high', maxEffort: 'low' } } } } })).toThrow(/maxEffort cannot be below effort/);
    expect(() => normalizeConfig({ models: { claude: { roles: [] } } })).toThrow(/roles must be an object/);
    const plain = reviewPolicySnapshot({ charter: '# C\n', lessons: '# L\n', config: { models: { claude: { effort: 'high' } } } });
    const tuned = reviewPolicySnapshot({ charter: '# C\n', lessons: '# L\n', config: { models: { claude: { effort: 'high', roles: { scout: { effort: 'medium' } } } } } });
    expect(tuned.policyDigest).not.toBe(plain.policyDigest);
  });

  it('checks the client version for a model only a role uses', () => {
    const config = normalizeConfig({ models: { claude: { model: 'claude-opus-5-5', roles: { scout: { model: 'claude-sonnet-5-5' } } } } });
    expect(() => validateModelClients(config, {
      selected: ['claude'], availability: { claude: { version: '2.1.282 (Claude Code)' } },
    })).toThrow(/2\.1\.284 or later is required for claude-sonnet-5-5/);
  });

  it('keeps the provider ceiling for a role that only changes its model', async () => {
    const { profileFor } = await import('../modelSettings.mjs');
    const config = normalizeConfig({ models: { claude: { effort: 'high', maxEffort: 'high', roles: { scout: { model: 'claude-sonnet-5-5' } } } } });
    expect(profileFor('claude', 'Scout', config)).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'high', maxEffort: 'high' });
  });
});
