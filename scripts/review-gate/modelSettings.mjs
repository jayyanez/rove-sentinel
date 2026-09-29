import { PROVIDER_PROFILE } from './constants.mjs';

export const PROVIDERS = Object.freeze(['claude', 'codex']);
export const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function normalizeModels(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('models must be an object.');
  const result = {};
  for (const [provider, settings] of Object.entries(input)) {
    if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported model provider: ${provider}`);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${provider} model settings must be an object.`);
    for (const key of Object.keys(settings)) {
      if (!['model', 'effort', 'maxEffort'].includes(key)) throw new Error(`Unknown ${provider} model setting: ${key}`);
      if (typeof settings[key] !== 'string') throw new Error(`${provider} ${key} must be a string.`);
    }
    const defaults = PROVIDER_PROFILE[`${provider}Reviewer`];
    const model = settings.model ?? defaults.model;
    const effort = settings.effort ?? defaults.effort;
    if (typeof model !== 'string' || model.length > 160 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) {
      throw new Error(`${provider} model must be a CLI model identifier of at most 160 characters.`);
    }
    const legacyClaude = provider === 'claude' && /^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(model);
    const defaultCeiling = legacyClaude ? 'high' : defaults.maxEffort;
    const maxEffort = settings.maxEffort ?? (EFFORTS.indexOf(effort) > EFFORTS.indexOf(defaultCeiling) ? effort : defaultCeiling);
    const supported = provider === 'claude' || model === 'gpt-6.1-sol'
      ? EFFORTS.slice(2) : EFFORTS;
    if (!supported.includes(effort) || !supported.includes(maxEffort)) throw new Error(`Invalid ${provider} effort or maxEffort for ${model}.`);
    if (legacyClaude && [effort, maxEffort].includes('xhigh')) {
      throw new Error(`${model} does not support xhigh; select high or max explicitly.`);
    }
    if (EFFORTS.indexOf(maxEffort) < EFFORTS.indexOf(effort)) throw new Error(`${provider} maxEffort cannot be below effort.`);
    result[provider] = { model, effort, maxEffort };
  }
  return result;
}

export function profileFor(provider, role, config = {}) {
  const defaults = PROVIDER_PROFILE[`${provider}${role}`];
  if (!defaults) throw new Error(`Unsupported review profile: ${provider}/${role}`);
  return { ...defaults, ...normalizeModels(config.models)[provider], role };
}

export function modelSettings(config = {}) {
  return Object.fromEntries(PROVIDERS.map((provider) => {
    const { model, effort, maxEffort } = profileFor(provider, 'Reviewer', config);
    return [provider, { model, effort, maxEffort }];
  }));
}

export function selectProviders(mode = 'auto', available = PROVIDERS) {
  if (!['auto', 'both', ...PROVIDERS].includes(mode)) throw new Error(`Invalid provider requirement: ${mode}`);
  if (!Array.isArray(available) || available.some((provider) => !PROVIDERS.includes(provider))) throw new Error('Invalid available provider set.');
  const selected = mode === 'auto' ? PROVIDERS.filter((provider) => available.includes(provider))
    : mode === 'both' ? [...PROVIDERS] : [mode];
  if (!selected.length || selected.some((provider) => !available.includes(provider))) {
    throw new Error(`Provider requirement ${mode} cannot be satisfied; install and authenticate ${mode === 'auto' ? 'at least one native Claude Code or Codex CLI' : mode}.`);
  }
  return selected;
}

export function validateModelClients(config, subscriptions) {
  for (const provider of subscriptions.selected) {
    const profile = profileFor(provider, 'Reviewer', config);
    const minimum = provider === 'codex' && profile.model === 'gpt-6.1-sol' ? [0, 159, 0]
      : provider === 'claude' && profile.model === 'claude-opus-5-5' ? [2, 1, 280]
      : provider === 'claude' && profile.model === 'claude-sonnet-5-5' ? [2, 1, 284] : null;
    const match = subscriptions.availability[provider]?.version?.match(/\b(\d+)\.(\d+)\.(\d+)\b/);
    if (!minimum || !match) continue;
    const version = match.slice(1).map(Number);
    const differing = version.findIndex((part, index) => part !== minimum[index]);
    if (differing !== -1 && version[differing] < minimum[differing]) {
      throw new Error(`${provider} ${minimum.join('.')} or later is required for ${profile.model}; detected ${version.join('.')}. Update the native CLI, or explicitly configure a model it supports. No fallback model was selected.`);
    }
  }
}
