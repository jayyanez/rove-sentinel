import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkForUpdates, compareVersions, releaseUrls, validateRelease, formatUpdateCheck } from '../updates.mjs';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
function release(version = '1.10.0') {
  const urls = releaseUrls(version);
  return { tag_name: `v${version}`, draft: false, prerelease: false, published_at: '2026-09-26T00:00:00Z',
    assets: [{ name: `rove-sentinel-${version}.tgz`, browser_download_url: urls.archiveUrl },
      { name: 'SHA256SUMS', browser_download_url: urls.checksumsUrl }] };
}
async function fixture(fetchImpl = vi.fn(async () => Response.json(release()))) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sentinel-updates-')); dirs.push(dir);
  return { cachePath: path.join(dir, 'cache.json'), installedVersion: '1.9.0', now: 10_000, fetchImpl };
}

describe('release discovery', () => {
  it('compares numeric stable versions and rejects ambiguous versions', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1);
    expect(compareVersions('2.0.0', '1.99.99')).toBe(1);
    expect(compareVersions('1.9.0', '1.9.0')).toBe(0);
    for (const version of ['01.9.0', '1.9', '1.9.0-beta', '1.9.0+build', '999999999999.0.0']) {
      expect(() => compareVersions(version, '1.9.0')).toThrow();
    }
  });
  it('offers only published stable releases with exact official assets', () => {
    expect(validateRelease(release()).version).toBe('1.10.0');
    for (const invalid of [{ ...release(), draft: true }, { ...release(), prerelease: true },
      { ...release(), tag_name: 'v1.10.0-rc.1' }, { ...release(), published_at: null },
      { ...release(), assets: [] }, { ...release(), assets: release().assets.map((a) => ({ ...a, browser_download_url: 'https://evil.example/asset' })) }]) {
      expect(() => validateRelease(invalid)).toThrow();
    }
  });
  it('returns structured availability and reuses a 24-hour cache', async () => {
    const options = await fixture();
    expect(await checkForUpdates(options)).toMatchObject({ status: 'available', latestVersion: '1.10.0', cached: false });
    expect(await checkForUpdates({ ...options, now: options.now + 100 })).toMatchObject({ status: 'available', cached: true });
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
    await checkForUpdates({ ...options, now: options.now + 86400000 });
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
    expect(options.fetchImpl.mock.calls[0][1]).toMatchObject({ redirect: 'error' });
    expect(Object.keys(options.fetchImpl.mock.calls[0][1].headers)).not.toContain('Authorization');
  });
  it('supports explicit refresh, opt-out and installed versions ahead of publication', async () => {
    const options = await fixture();
    expect(await checkForUpdates({ ...options, enabled: false })).toMatchObject({ status: 'disabled' });
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await checkForUpdates({ ...options, installedVersion: '1.10.0' })).toMatchObject({ status: 'current' });
    expect(await checkForUpdates({ ...options, installedVersion: '1.11.0' })).toMatchObject({ status: 'ahead' });
    await checkForUpdates({ ...options, force: true });
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('does not treat an offline lookup as evidence of being current, and backs off for one hour', async () => {
    const options = await fixture(vi.fn(async () => { throw new Error('offline'); }));
    expect(await checkForUpdates(options)).toMatchObject({ status: 'unavailable', cached: false });
    expect(await checkForUpdates({ ...options, now: options.now + 1000 })).toMatchObject({ status: 'unavailable', cached: true });
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
    await checkForUpdates({ ...options, now: options.now + 3600000 });
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
  });
  it('ignores corrupt, future-dated, and oversized caches', async () => {
    const options = await fixture();
    for (const content of ['{', 'x'.repeat(5000), JSON.stringify({ schemaVersion: 1, checkedAt: options.now + 1000, release: { version: '8.0.0' } })]) {
      await writeFile(options.cachePath, content);
      expect(await checkForUpdates(options)).toMatchObject({ status: 'available', latestVersion: '1.10.0', cached: false });
    }
    expect(options.fetchImpl).toHaveBeenCalledTimes(3);
  });
  it('tolerates HTTP failures, malformed JSON and oversized metadata', async () => {
    for (const response of [new Response('denied', { status: 403 }), new Response('{'), new Response('x'.repeat(131073))]) {
      const options = await fixture(vi.fn(async () => response));
      expect(await checkForUpdates(options)).toMatchObject({ status: 'unavailable' });
    }
  });
  it('bounds network waits and survives unwritable cache locations', async () => {
    const options = await fixture(vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })));
    expect(await checkForUpdates({ ...options, timeoutMs: 20 })).toMatchObject({ status: 'unavailable' });
    const valid = await fixture();
    await writeFile(valid.cachePath, 'not a directory');
    expect(await checkForUpdates({ ...valid, cachePath: path.join(valid.cachePath, 'child') })).toMatchObject({ status: 'available' });
  });
  it('distinguishes release availability from actual activation', () => {
    expect(formatUpdateCheck({ status: 'available', installedVersion: '1.9.0', latestVersion: '1.10.0', releaseUrl: releaseUrls('1.10.0').releaseUrl })).toContain('inspect activation progress');
    expect(formatUpdateCheck({ status: 'unavailable' })).toContain('unchanged');
  });
});
