import { LIMITS } from './constants.mjs';
import { PROVIDERS } from './modelSettings.mjs';
import { atomicWriteJson, readJson, removeStoredJson } from './storage.mjs';

/**
 * A provider's subscription usage limit: typed detection, the reset
 * time the CLI reported, and the local record `providers: "auto"` uses to
 * leave an exhausted provider out of new reviews until that reset.
 *
 * Classification reads only a FAILED provider process's own error output
 * (a non-zero exit, an `is_error` result, an error line or event), never a
 * completed reviewer's content: a diff that quotes these phrases cannot
 * trigger it. See docs/plans/provider-usage-limit-fallback.md for which
 * wordings were verified and which were assumed.
 */

export const USAGE_LIMIT_CODE = 'PROVIDER_USAGE_LIMIT';
// Raised by the gate for provider work it did not start because a sibling
// already hit a usage limit: the round is discarded, so it is not launched.
export const USAGE_LIMIT_HALT_CODE = 'PROVIDER_USAGE_LIMIT_HALT';

export class ProviderUsageLimitError extends Error {
  constructor(provider, { resetAt = null, message = 'usage limit reached' } = {}) {
    super(`${provider} usage limit reached${resetAt ? ` (resets ${new Date(resetAt).toISOString()})` : ''}: ${message}`);
    this.name = 'ProviderUsageLimitError';
    this.code = USAGE_LIMIT_CODE;
    this.provider = provider;
    this.resetAt = resetAt;
    this.limitMessage = message;
  }
}

export function isProviderUsageLimit(error) {
  return error?.code === USAGE_LIMIT_CODE && PROVIDERS.includes(error?.provider);
}

// Each is specific to a subscription's usage or plan limit. A transient
// rate limit (HTTP 429, "rate limit") is deliberately not among them: it is
// retried, never recorded.
const LIMIT_PHRASES = [
  // "Claude AI usage limit reached|<epoch>", Codex `usage_limit_reached`.
  /\busage[ _]limit[ _](?:reached|exceeded)\b/i,
  // "You've hit your usage limit", "You've hit your weekly limit",
  // "You have reached your 5-hour limit", "You've hit your limit".
  /\b(?:hit|reached) your (?:(?:usage|weekly|daily|monthly|session|5-hour|five-hour|opus|sonnet|plan|subscription)\s+)*limits?\b/i,
  // "5-hour limit reached ∙ resets 3pm", "Weekly limit reached".
  /\b(?:5-hour|five-hour|weekly|daily|monthly|session|opus|sonnet) limits? reached\b/i,
  // "You're out of extra usage".
  /\bout of (?:extra )?usage\b/i,
];

const sanitize = (text) => String(text)
  // eslint-disable-next-line no-control-regex
  .replace(/[\u0000-\u001f\u007f]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim()
  .slice(0, LIMITS.providerHoldMessageChars);

/**
 * The usage-limit signature in a provider's error text, or null. `text` must
 * be error output only; the caller decides what counts as that.
 */
export function classifyUsageLimit(text, { now = Date.now() } = {}) {
  if (typeof text !== 'string' || !text) return null;
  const lines = text.split(/\r?\n/);
  const line = lines.find((candidate) => LIMIT_PHRASES.some((phrase) => phrase.test(candidate)));
  if (line === undefined) return null;
  // The reset is read from the line that reported the limit; from the rest
  // of the text only when it is one short message, so that an unrelated
  // "try again in 5 seconds" in a longer log is not taken for it.
  const resetAt = parseResetTime(line, { now }) ?? (text.length <= 2048 ? parseResetTime(text, { now }) : null);
  return { resetAt, message: sanitize(line) || 'usage limit reached' };
}

const UNIT_MS = {
  d: 86_400_000, day: 86_400_000, days: 86_400_000,
  h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
  m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
};
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const ZONE = String.raw`(?:\s*\(\s*([A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+|UTC|GMT)\s*\))?`;
const CLOCK = String.raw`(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m\.?`;

/** Epoch milliseconds from an epoch in seconds or milliseconds. */
function epochMs(digits) {
  const value = Number(digits);
  if (!Number.isFinite(value)) return null;
  return digits.length >= 12 ? value : value * 1000;
}

/** The UTC offset of a time zone at an instant, in milliseconds. */
function zoneOffsetMs(timeZone, instant) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(new Date(instant)).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The calendar date of an instant in a time zone (local when none). */
function wallDate(instant, timeZone) {
  if (!timeZone) {
    const date = new Date(instant);
    return { year: date.getFullYear(), month: date.getMonth() + 1, day: date.getDate() };
  }
  const shifted = new Date(instant + zoneOffsetMs(timeZone, instant));
  return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate() };
}

/** The instant a wall-clock time names in a time zone (local when none). */
function wallTimeMs({ year, month, day, hour, minute }, timeZone) {
  if (!timeZone) return new Date(year, month - 1, day, hour, minute).getTime();
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(timeZone, guess);
  const second = guess - zoneOffsetMs(timeZone, first);
  return second;
}

function hour24(hour, meridiem) {
  const value = Number(hour);
  if (value < 1 || value > 12) return null;
  return (value % 12) + (meridiem.toLowerCase() === 'p' ? 12 : 0);
}

/**
 * When a reported limit resets, in epoch milliseconds, or null when the text
 * names no reset that can be read. A reset in the past is null; one past the
 * hold bound is held to it.
 */
export function parseResetTime(text, { now = Date.now() } = {}) {
  const value = parseResetCandidate(String(text ?? ''), now);
  if (value === null || !Number.isFinite(value) || value <= now) return null;
  return Math.min(value, now + LIMITS.providerHoldMaxMs);
}

function parseResetCandidate(text, now) {
  // Claude Code: "Claude AI usage limit reached|1767225600".
  const pipe = text.match(/usage limit reached\|(\d{9,13})\b/i);
  if (pipe) return epochMs(pipe[1]);
  // Codex error events: resets_in_seconds / resets_at (epoch or ISO).
  const inSeconds = text.match(/"?resets_in_seconds"?\s*[:=]\s*(\d+)/i);
  if (inSeconds) return now + Number(inSeconds[1]) * 1000;
  const at = text.match(/"?resets_at"?\s*[:=]\s*"?(\d{9,13}|\d{4}-\d{2}-\d{2}T[^"\s,}]+)/i);
  if (at) return /^\d+$/.test(at[1]) ? epochMs(at[1]) : Date.parse(at[1]);
  // "try again in 2 days 3 hours 5 minutes", "try again in 45 min".
  const duration = text.match(/\btry again in\s+((?:\d+\s*[a-z]+[\s,]*(?:and\s+)?)+)/i);
  if (duration) {
    let total = 0;
    for (const [, amount, unit] of duration[1].matchAll(/(\d+)\s*([a-z]+)/gi)) {
      const step = UNIT_MS[unit.toLowerCase()];
      if (!step) break;
      total += Number(amount) * step;
    }
    if (total > 0) return now + total;
  }
  try {
    // "resets Nov 9 at 10am (America/Los_Angeles)", "resets Nov 9, 10am".
    const dated = text.match(new RegExp(String.raw`\b(?:resets?|try again)\s+(?:on\s+)?(${MONTHS.join('|')})[a-z]*\.?\s+(\d{1,2}),?\s+(?:at\s+)?${CLOCK}${ZONE}`, 'i'));
    if (dated) {
      const timeZone = dated[6];
      const month = MONTHS.indexOf(dated[1].toLowerCase()) + 1;
      const hour = hour24(dated[3], dated[5]);
      const day = Number(dated[2]);
      if (hour === null || day < 1 || day > 31) return null;
      const { year } = wallDate(now, timeZone);
      const minute = Number(dated[4] ?? 0);
      const thisYear = wallTimeMs({ year, month, day, hour, minute }, timeZone);
      if (thisYear > now) return thisYear;
      // A date just past is no reset at all; one months back is next year's.
      return now - thisYear < 30 * 86_400_000 ? null : wallTimeMs({ year: year + 1, month, day, hour, minute }, timeZone);
    }
    // "resets 1am (America/Los_Angeles)", "will reset at 3pm", "try again at 3:05 PM".
    const clock = text.match(new RegExp(String.raw`\b(?:resets?|try again)\s+(?:at\s+)?${CLOCK}${ZONE}`, 'i'));
    if (clock) {
      const timeZone = clock[4];
      const hour = hour24(clock[1], clock[3]);
      const minute = Number(clock[2] ?? 0);
      if (hour === null || minute > 59) return null;
      const today = wallDate(now, timeZone);
      const first = wallTimeMs({ ...today, hour, minute }, timeZone);
      if (first > now) return first;
      const next = new Date(Date.UTC(today.year, today.month - 1, today.day + 1));
      return wallTimeMs({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour, minute }, timeZone);
    }
  } catch {
    // An unknown time zone name: the reset cannot be read.
    return null;
  }
  return null;
}

/**
 * Whether a FAILED provider run's error is its usage limit, as a typed error,
 * or null. Only the CLI's own error output is read: for Claude Code the
 * `result` of an `is_error` JSON envelope and its standard error; for Codex
 * the error lines and error events of its output. A successful run never
 * reaches this function.
 */
export function usageLimitFromFailure(provider, error, { now = Date.now() } = {}) {
  if (!error) return null;
  if (isProviderUsageLimit(error)) return error;
  const texts = [];
  if (typeof error.providerError === 'string') texts.push(error.providerError);
  const result = error.result && typeof error.result === 'object' ? error.result : null;
  // A timeout, an output overflow or a launch failure is not a usage limit.
  const exitFailure = error.code === 'NON_ZERO_EXIT';
  if (result && exitFailure) {
    if (provider === 'claude') {
      const envelope = parseEnvelope(result.stdout);
      if (envelope?.is_error && typeof envelope.result === 'string') texts.push(envelope.result);
      if (typeof result.stderr === 'string') texts.push(tail(result.stderr));
    } else {
      texts.push(...codexErrorLines(`${tail(result.stderr)}\n${tail(result.stdout)}`));
    }
  }
  for (const text of texts) {
    const found = classifyUsageLimit(text, { now });
    if (found) return new ProviderUsageLimitError(provider, found);
  }
  return null;
}

function tail(text) {
  return typeof text === 'string' ? text.slice(-16 * 1024) : '';
}

function parseEnvelope(stdout) {
  if (typeof stdout !== 'string' || !stdout.trim()) return null;
  try {
    const value = JSON.parse(stdout);
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The lines of Codex output that are its own errors: an `ERROR:` line
 * (optionally after a bracketed timestamp) or a JSON error event. Command
 * output a reviewer printed is indented or prefixed by a diff marker, and is
 * left out.
 */
function codexErrorLines(text) {
  const lines = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^(?:\[[^\]\r\n]{1,64}\]\s*)?(?:ERROR|error|Error)\s*:/.test(line)) {
      lines.push(line);
      continue;
    }
    if (!line.startsWith('{')) continue;
    const event = parseEnvelope(line);
    const type = typeof event?.type === 'string' ? event.type : event?.msg?.type;
    if (!['error', 'turn.failed', 'stream_error'].includes(type)) continue;
    // Keep the event whole: its code and reset fields are what is parsed.
    lines.push(line);
  }
  return lines;
}

// --- Provider holds ------------------------------------------------------
//
// A hold keeps a provider out of `providers: "auto"` reviews for a while:
// `usage-limit` until the reset its CLI reported (or the re-probe window),
// `provider-failure` for the re-probe window after it failed a review twice
// and the review fell back to the other provider. A hold expires by itself,
// and a provider that completes work has its hold removed.

export const HOLD_REASONS = Object.freeze(['usage-limit', 'provider-failure']);

function validRecord(value) {
  return Boolean(value && typeof value === 'object' &&
    (value.reason === undefined || HOLD_REASONS.includes(value.reason)) &&
    typeof value.since === 'string' && Number.isFinite(Date.parse(value.since)) &&
    typeof value.retryAfter === 'string' && Number.isFinite(Date.parse(value.retryAfter)) &&
    (value.resetAt === null || (typeof value.resetAt === 'string' && Number.isFinite(Date.parse(value.resetAt)))) &&
    typeof value.message === 'string');
}

async function readRaw(paths) {
  let value;
  try {
    value = await readJson(paths.providerHolds, null);
  } catch {
    // A corrupt record cannot hold a provider back.
    return {};
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(PROVIDERS.filter((provider) => validRecord(value[provider]))
    .map((provider) => [provider, { reason: 'usage-limit', ...value[provider] }]));
}

/** Live holds by provider; expired holds are not returned. */
export async function readProviderHolds(paths, { now = Date.now() } = {}) {
  const raw = await readRaw(paths);
  return Object.fromEntries(Object.entries(raw).filter(([, record]) => Date.parse(record.retryAfter) > now));
}

/** One hold for a provider that hit its limit, or failed, at `now`. */
export function providerHoldRecord({ reason = 'usage-limit', resetAt = null, message } = {}, { now = Date.now() } = {}) {
  const limit = reason === 'usage-limit';
  // Only a usage limit has a reset time; a failure is re-probed.
  const reset = limit && Number.isFinite(resetAt) && resetAt > now ? Math.min(resetAt, now + LIMITS.providerHoldMaxMs) : null;
  return {
    reason: limit ? 'usage-limit' : 'provider-failure',
    since: new Date(now).toISOString(),
    resetAt: reset === null ? null : new Date(reset).toISOString(),
    retryAfter: new Date(reset ?? now + LIMITS.providerHoldReprobeMs).toISOString(),
    message: sanitize(message ?? '') || (limit ? 'usage limit reached' : 'provider failed'),
  };
}

/** Record holds; other live holds are kept. A usage limit outranks a failure. */
export async function recordProviderHolds(paths, hits, { now = Date.now() } = {}) {
  const records = await readProviderHolds(paths, { now });
  const added = {};
  for (const hit of hits) {
    if (!PROVIDERS.includes(hit?.provider)) continue;
    const record = providerHoldRecord(hit, { now });
    const held = added[hit.provider];
    const stronger = !held || (record.reason === 'usage-limit' && held.reason !== 'usage-limit')
      || (record.reason === held.reason && Date.parse(record.retryAfter) > Date.parse(held.retryAfter));
    if (stronger) added[hit.provider] = record;
  }
  if (!Object.keys(added).length) return records;
  const next = { ...records, ...added };
  await atomicWriteJson(paths.providerHolds, next);
  return next;
}

/** A provider that just completed work has its hold removed. */
export async function clearProviderHolds(paths, providers) {
  const raw = await readRaw(paths);
  const remaining = Object.fromEntries(Object.entries(raw).filter(([provider]) => !providers.includes(provider)));
  if (Object.keys(remaining).length === Object.keys(raw).length) return;
  if (Object.keys(remaining).length) await atomicWriteJson(paths.providerHolds, remaining);
  else await removeStoredJson(paths.providerHolds);
}

/** "codex usage limit reached; retry after 2026-11-10T15:00:00.000Z" */
export function describeProviderHold(provider, record) {
  if (record.reason === 'provider-failure') {
    return `${provider} failed a recent review and is held back; retry after ${record.retryAfter}`;
  }
  return `${provider} usage limit reached; retry after ${record.retryAfter}${record.resetAt ? '' : ' (no readable reset time was reported; Sentinel tries it again then)'}`;
}

/**
 * The providers of `candidates` a hold keeps out of a review. Under `auto` a
 * usage limit always does; a failure hold only while another candidate is
 * free, so a past failure never leaves a review with no provider. An
 * explicit requirement is refused by a usage limit only: failure holds are
 * written under `auto` and are never a reason to refuse a required provider.
 */
export function heldProviders(mode, candidates, holds = {}) {
  const limited = candidates.filter((provider) => holds[provider] && holds[provider].reason !== 'provider-failure');
  if (mode !== 'auto') return limited;
  const failed = candidates.filter((provider) => holds[provider]?.reason === 'provider-failure');
  const free = candidates.filter((provider) => !holds[provider]);
  return free.length ? [...limited, ...failed] : limited;
}

/** One line naming the provider a review left out, and why. */
export function formatProviderFallback(fallback) {
  if (!fallback?.dropped?.length) return '';
  const why = fallback.reason === 'provider-failure' ? 'it failed and its retry failed' : 'its usage limit';
  return `Provider fallback: ${fallback.dropped.join(' and ')} left out after ${why} (retry after ${fallback.retryAfter ?? fallback.resetAt ?? 'unknown'}); ${fallback.restarted ? 'the review restarted from scratch without it' : 'the review was planned without it'}.`;
}
