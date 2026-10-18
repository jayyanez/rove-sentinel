import { PROVIDER_PROFILE } from './constants.mjs';

export const PROVIDERS = Object.freeze(['claude', 'codex']);
export const EFFORTS = Object.freeze(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
// Roles a project may give its own model or effort (1.13.0), by the key used
// in configuration and the profile name used in code.
export const ROLES = Object.freeze({
  scout: 'Scout',
  hypothesis: 'Hypothesis',
  shard: 'Shard',
  reviewer: 'Reviewer',
  coordinator: 'Coordinator',
});
const SETTING_KEYS = ['model', 'effort', 'maxEffort'];

/**
 * One provider's settings resolved against `defaults`: the omitted fields
 * come from the defaults, and an omitted ceiling rises to the effort when the
 * effort is above the default ceiling.
 */
function resolveSettings(provider, settings, defaults, label) {
  for (const key of SETTING_KEYS) {
    if (settings[key] !== undefined && typeof settings[key] !== 'string') throw new Error(`${label} ${key} must be a string.`);
  }
  const model = settings.model ?? defaults.model;
  const effort = settings.effort ?? defaults.effort;
  if (typeof model !== 'string' || model.length > 160 || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) {
    throw new Error(`${label} model must be a CLI model identifier of at most 160 characters.`);
  }
  const legacyClaude = provider === 'claude' && /^claude-(?:opus|sonnet)-4-6(?:-|$)/.test(model);
  // A role inherits its provider's ceiling, whatever model it names.
  const defaultCeiling = legacyClaude ? 'high' : defaults.maxEffort;
  const maxEffort = settings.maxEffort ?? (EFFORTS.indexOf(effort) > EFFORTS.indexOf(defaultCeiling) ? effort : defaultCeiling);
  const supported = provider === 'claude' || model === 'gpt-6.1-sol'
    ? EFFORTS.slice(2) : EFFORTS;
  if (!supported.includes(effort) || !supported.includes(maxEffort)) throw new Error(`Invalid ${label} effort or maxEffort for ${model}.`);
  if (legacyClaude && [effort, maxEffort].includes('xhigh')) {
    throw new Error(`${model} does not support xhigh; select high or max explicitly.`);
  }
  if (EFFORTS.indexOf(maxEffort) < EFFORTS.indexOf(effort)) throw new Error(`${label} maxEffort cannot be below effort.`);
  return { model, effort, maxEffort };
}

export function normalizeModels(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('models must be an object.');
  const result = {};
  for (const [provider, settings] of Object.entries(input)) {
    if (!PROVIDERS.includes(provider)) throw new Error(`Unsupported model provider: ${provider}`);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error(`${provider} model settings must be an object.`);
    for (const key of Object.keys(settings)) {
      if (![...SETTING_KEYS, 'roles'].includes(key)) throw new Error(`Unknown ${provider} model setting: ${key}`);
    }
    const resolved = resolveSettings(provider, settings, PROVIDER_PROFILE[`${provider}Reviewer`], provider);
    // Per-role settings (1.13.0) resolve against the provider's own; a role
    // left out uses the provider's settings. Only the roles a project names
    // are kept, so an existing installed policy stays reproducible.
    if (settings.roles !== undefined) {
      if (!settings.roles || typeof settings.roles !== 'object' || Array.isArray(settings.roles)) {
        throw new Error(`${provider} roles must be an object.`);
      }
      const roles = {};
      for (const [role, roleSettings] of Object.entries(settings.roles)) {
        if (!Object.hasOwn(ROLES, role)) throw new Error(`Unknown ${provider} role: ${role}. Expected one of ${Object.keys(ROLES).join(', ')}.`);
        if (!roleSettings || typeof roleSettings !== 'object' || Array.isArray(roleSettings)) throw new Error(`${provider} ${role} settings must be an object.`);
        for (const key of Object.keys(roleSettings)) {
          if (!SETTING_KEYS.includes(key)) throw new Error(`Unknown ${provider} ${role} setting: ${key}`);
        }
        roles[role] = resolveSettings(provider, roleSettings, resolved, `${provider} ${role}`);
      }
      resolved.roles = Object.fromEntries(Object.keys(ROLES).filter((role) => roles[role]).map((role) => [role, roles[role]]));
    }
    result[provider] = resolved;
  }
  return result;
}

export function profileFor(provider, role, config = {}) {
  const defaults = PROVIDER_PROFILE[`${provider}${role}`];
  if (!defaults) throw new Error(`Unsupported review profile: ${provider}/${role}`);
  const settings = normalizeModels(config.models)[provider];
  const roleKey = Object.keys(ROLES).find((key) => ROLES[key] === role);
  const { roles, ...providerSettings } = settings || {};
  return { ...defaults, ...providerSettings, ...(roleKey && roles?.[roleKey] ? roles[roleKey] : {}), role };
}

export function modelSettings(config = {}) {
  const models = normalizeModels(config.models);
  return Object.fromEntries(PROVIDERS.map((provider) => {
    const { model, effort, maxEffort } = models[provider] ?? PROVIDER_PROFILE[`${provider}Reviewer`];
    const roles = models[provider]?.roles;
    return [provider, { model, effort, maxEffort, ...(roles && Object.keys(roles).length ? { roles } : {}) }];
  }));
}

/** Every distinct model and effort pair a provider's roles can request. */
export function providerProfiles(provider, config = {}) {
  const seen = new Map();
  for (const role of Object.values(ROLES)) {
    const { model, effort, maxEffort } = profileFor(provider, role, config);
    const key = `${model}\0${effort}\0${maxEffort}`;
    if (!seen.has(key)) seen.set(key, { model, effort, maxEffort });
  }
  return [...seen.values()];
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
    // Every model a role of this provider can use needs a client that knows it.
    for (const profile of providerProfiles(provider, config)) {
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
}
