import { open } from 'node:fs/promises';
import path from 'node:path';
import { GATE_VERSION } from './constants.mjs';
import { atomicWriteJson, stateRootFor } from './storage.mjs';

export const RELEASE_REPOSITORY = 'jayyanez/rove-sentinel';
export const RELEASE_API = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;
const MAX_RESPONSE_BYTES = 128 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

export function stableVersion(value) {
  return typeof value === 'string' && /^\d{1,9}\.\d{1,9}\.\d{1,9}$/.test(value)
    && value.split('.').every((part) => part === '0' || !part.startsWith('0'));
}

export function compareVersions(left, right) {
  if (!stableVersion(left) || !stableVersion(right)) throw new Error('Expected stable semantic versions.');
  const a = left.split('.').map(Number);
  const b = right.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return Math.sign(a[i] - b[i]);
  return 0;
}

export function releaseUrls(version) {
  if (!stableVersion(version)) throw new Error('Invalid release version.');
  const root = `https://github.com/${RELEASE_REPOSITORY}/releases`;
  return {
    releaseUrl: `${root}/tag/v${version}`,
    archiveUrl: `${root}/download/v${version}/rove-sentinel-${version}.tgz`,
    checksumsUrl: `${root}/download/v${version}/SHA256SUMS`,
  };
}

export function validateRelease(release) {
  const version = typeof release?.tag_name === 'string' ? release.tag_name.replace(/^v/, '') : '';
  if (!stableVersion(version) || release.tag_name !== `v${version}`
    || release.draft !== false || release.prerelease !== false
    || !Number.isFinite(Date.parse(release.published_at)) || !Array.isArray(release.assets)) {
    throw new Error('GitHub did not return a published stable Sentinel release.');
  }
  const urls = releaseUrls(version);
  for (const [name, url] of [[`rove-sentinel-${version}.tgz`, urls.archiveUrl], ['SHA256SUMS', urls.checksumsUrl]]) {
    if (!release.assets.some((asset) => asset.name === name && asset.browser_download_url === url)) {
      throw new Error('Release is missing its expected archive or checksum asset.');
    }
  }
  return { version, ...urls };
}

async function readBoundedJson(response) {
  if (!response.ok) throw new Error(`GitHub release lookup returned HTTP ${response.status}.`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error('GitHub returned no release metadata.');
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw new Error('Release metadata exceeds the size limit.');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Advisory only: no repository content, credentials, installs or policy changes. */
export async function checkForUpdates({
  installedVersion = GATE_VERSION,
  enabled = process.env.ROVE_SENTINEL_UPDATE_CHECK !== '0',
  force = false,
  cachePath = path.join(stateRootFor(`https://github.com/${RELEASE_REPOSITORY}`), 'release-cache.json'),
  now = Date.now(),
  fetchImpl = globalThis.fetch,
  timeoutMs = 3_000,
} = {}) {
  if (!enabled) return { status: 'disabled', installedVersion };
  const finish = (record, cached) => {
    if (!record.release) return { status: 'unavailable', installedVersion, checkedAt: record.checkedAt, cached };
    const comparison = compareVersions(record.release.version, installedVersion);
    return { status: comparison > 0 ? 'available' : comparison < 0 ? 'ahead' : 'current',
      installedVersion, latestVersion: record.release.version, ...releaseUrls(record.release.version),
      checkedAt: record.checkedAt, cached };
  };
  try {
    if (!stableVersion(installedVersion)) throw new Error('Invalid installed version.');
    if (!force) {
      try {
        // Read only a bounded cache file; treat corruption as a cache miss.
        const file = await open(cachePath, 'r');
        let raw;
        try {
          const buffer = Buffer.alloc(4097);
          const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
          if (bytesRead > 4096) throw new Error('Oversize cache.');
          raw = buffer.subarray(0, bytesRead).toString('utf8');
        }
        finally { await file.close(); }
        const cached = JSON.parse(raw);
        const age = now - cached.checkedAt;
        if (cached.schemaVersion === 1 && Number.isFinite(cached.checkedAt) && Number.isFinite(age) && age >= 0
          && (cached.release === null || stableVersion(cached.release?.version))
          && age < (cached.release ? DAY : HOUR)) return finish(cached, true);
      } catch { /* Re-fetch corrupt, absent or inaccessible cache. */ }
    }
    let release = null;
    try {
      const response = await fetchImpl(RELEASE_API, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'rove-sentinel-update-check' },
        redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      });
      release = validateRelease(await readBoundedJson(response));
    } catch { /* Rate limits, offline hosts and invalid metadata are advisory. */ }
    const record = { schemaVersion: 1, checkedAt: now, release };
    try { await atomicWriteJson(cachePath, record); } catch { /* Read-only state cannot break status. */ }
    return finish(record, false);
  } catch { return { status: 'unavailable', installedVersion }; }
}

export function formatUpdateCheck(result) {
  if (result.status === 'available') return `Rove Sentinel ${result.latestVersion} is available (running: ${result.installedVersion}).\nRelease notes: ${result.releaseUrl}\nThe Windows watcher updates automatically when idle, unless disabled. Run rove-sentinel updates to inspect activation progress.`;
  if (result.status === 'current') return `Rove Sentinel ${result.installedVersion} is the latest published stable release.`;
  if (result.status === 'ahead') return `Installed ${result.installedVersion}; latest published stable release is ${result.latestVersion}. No downgrade proposed.`;
  if (result.status === 'disabled') return 'Release update checks are disabled.';
  return 'Release update check unavailable. Your installed version and review behavior are unchanged.';
}
