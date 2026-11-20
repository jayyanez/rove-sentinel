import path from 'node:path';
import { REPAIR_COMMAND, runProcess } from './process.mjs';
import { atomicWriteJson, readJson } from './storage.mjs';
import { compareVersions, stableVersion } from './updates.mjs';

const HOLDS = {
  paused: 'the review watcher is paused',
  stopped: 'the review watcher is not running',
  unreadable: 'the review watcher cannot be checked',
  outdated: 'the review watcher runs another engine or policy',
  'queue-lock': 'the review queue is locked',
  interrupted: 'an earlier activation was interrupted',
};

const RUN_REPAIR = `Run: ${REPAIR_COMMAND}`;
const clause = (text) => String(text).replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');
// A reason that already names the repair command: the line names it once, at its end.
const reasonClause = (text) => clause(String(text).replace(/\s*Run: [^\n]*$/, ''));

/** One hold from `watcherHolds`, as a clause; the line it ends up in names the command. */
export function describeHold({ kind, since, reason }) {
  return `${HOLDS[kind] ?? 'the review watcher holds it'}${since ? ` (since ${since})` : ''}: ${reasonClause(reason)}`;
}

export function longPauseMessage({ pausedAt, reason }, project) {
  return `The review watcher for ${project} has been paused since ${pausedAt}: ${reasonClause(reason)}. Pushes without a passing review are refused and no update activates until it resumes. ${RUN_REPAIR}`;
}

const newer = (pending, running) => stableVersion(pending) && (!stableVersion(running) || compareVersions(pending, running) > 0);

const lastAttempt = (lastError) => (lastError ? ` Last attempt: ${clause(lastError)}.` : '');

/**
 * One line per state, each ending with the command to run, so an agent that
 * reads a review log acts on the line itself.
 */
export function updateMessage({ phase, activeVersion, pendingVersion, attemptedVersion, lastError, blockedBy, runningVersion, automatic }, project) {
  if (phase === 'active') return `Rove Sentinel updated to ${activeVersion} for ${project}. New reviews use it; existing agents can continue.`;
  // `automatic` is false only where updates are switched off; a notification's state has no such field.
  const current = phase === 'download-failed' ? attemptedVersion || pendingVersion : pendingVersion;
  if (automatic === false && ['waiting', 'download-failed'].includes(phase) && newer(current, runningVersion)) {
    return `Rove Sentinel ${current} was downloading or downloaded for ${project}, but automatic updates are disabled here (updates --disable, or ROVE_SENTINEL_AUTO_UPDATE=0), so it will not activate. To turn them back on where that variable is not set, run: npx --no-install rove-sentinel updates --enable`;
  }
  if (['waiting', 'activating'].includes(phase) && blockedBy?.length) {
    return `Rove Sentinel ${pendingVersion} is downloaded for ${project} but cannot activate: ${blockedBy.map(describeHold).join('; ')}.${lastAttempt(lastError)} ${RUN_REPAIR}`;
  }
  if (phase === 'waiting') {
    return `Rove Sentinel ${pendingVersion} is downloaded for ${project}. It will activate after current reviews finish.${lastAttempt(lastError)}`;
  }
  if (phase === 'download-failed' && newer(current, runningVersion)) {
    return `Rove Sentinel ${current} could not be downloaded for ${project}; the running engine is unchanged.${lastError ? ` ${clause(lastError)}.` : ''} ${RUN_REPAIR}`;
  }
  if (phase === 'failed') return `Rove Sentinel could not activate the update for ${project}. The previous version remains active.${lastError ? ` ${clause(lastError)}.` : ''} ${RUN_REPAIR}`;
  if (phase === 'recovery-required') return `Rove Sentinel needs recovery for ${project}. Reviews are paused. ${RUN_REPAIR}`;
  return null;
}

/** Native Windows notification with no persistent window, tray process, or added dependency. */
export async function notifyUpdate(context, state, { run = runProcess, platform = process.platform, env = process.env } = {}) {
  const message = updateMessage(state, path.basename(context.repoRoot));
  if (!message || platform !== 'win32' || env.ROVE_SENTINEL_UPDATE_NOTIFICATIONS === '0') return { attempted: false };
  const key = `${state.phase}:${state.activeVersion || ''}:${state.pendingVersion || ''}`;
  const file = path.join(context.paths.root, 'update-notification.json');
  if ((await readJson(file))?.key === key) return { attempted: false };
  // A failed notification must not repeat every watcher poll. The CLI always retains the state.
  await atomicWriteJson(file, { key, attemptedAt: Date.now() });
  const encoded = Buffer.from(message.slice(0, 240), 'utf8').toString('base64');
  const script = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$sentinelIcon = New-Object System.Windows.Forms.NotifyIcon
try {
  $sentinelIcon.Icon = [System.Drawing.SystemIcons]::Shield
  $sentinelIcon.Text = 'Rove Sentinel'
  $sentinelIcon.Visible = $true
  $sentinelText = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))
  $sentinelIcon.ShowBalloonTip(5000, 'Rove Sentinel', $sentinelText, [System.Windows.Forms.ToolTipIcon]::Info)
  $sentinelUntil = [DateTime]::UtcNow.AddSeconds(6)
  while ([DateTime]::UtcNow -lt $sentinelUntil) { [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 100 }
} finally { $sentinelIcon.Dispose() }
`;
  try {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { timeoutMs: 10_000, maxOutputBytes: 16 * 1024 });
    return { attempted: true };
  } catch (error) { return { attempted: true, error: error.message }; }
}
