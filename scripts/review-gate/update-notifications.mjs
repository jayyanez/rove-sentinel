import path from 'node:path';
import { runProcess } from './process.mjs';
import { atomicWriteJson, readJson } from './storage.mjs';

export function updateMessage({ phase, activeVersion, pendingVersion, lastError }, project) {
  if (phase === 'active') return `Rove Sentinel updated to ${activeVersion} for ${project}. New reviews use it; existing agents can continue.`;
  if (phase === 'waiting') return `Rove Sentinel ${pendingVersion} is downloaded for ${project}. It will activate after current reviews finish.`;
  if (phase === 'failed') return `Rove Sentinel could not activate the update for ${project}. The previous version remains active. ${lastError || ''}`;
  if (phase === 'recovery-required') return `Rove Sentinel needs recovery for ${project}. Reviews are paused. Run rove-sentinel updates for details.`;
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
