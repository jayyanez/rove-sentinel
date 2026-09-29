import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../config.mjs';
import { reviewPolicySnapshot } from '../context.mjs';
import { PROVIDER_PROFILE } from '../constants.mjs';
import { reviewPlan } from '../risk.mjs';
import { validateModelClients } from '../modelSettings.mjs';

describe('project model profiles and provider requirements', () => {
  it('pins all default roles to the requested models at high effort', () => {
    for (const [role, profile] of Object.entries(PROVIDER_PROFILE)) {
      expect(profile.model).toBe(role.startsWith('claude') ? 'claude-opus-5-5' : 'gpt-6.1-sol');
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

  it.each([
    { providers: 'anything' }, { models: [] }, { models: { other: {} } },
    { models: { claude: { model: '--invalid' } } },
    { models: { codex: { effort: 'ultra' } } },
    { models: { claude: { effort: 'none' } } },
    { models: { codex: { effort: 'high', maxEffort: 'low' } } },
    { models: { codex: { model: 'gpt-6.1-sol', effort: 'none' } } },
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
    const subscriptions = { selected: ['codex'], availability: { codex: { version: 'codex-cli 0.154.0' } } };
    expect(() => validateModelClients({}, subscriptions)).toThrow(/0.159.0 or later/);
    expect(() => validateModelClients({ models: { codex: { model: 'gpt-5.6-sol' } } }, subscriptions)).not.toThrow();
    expect(() => validateModelClients({}, { ...subscriptions, availability: { codex: { version: 'codex-cli 0.159.0' } } })).not.toThrow();
  });
});
