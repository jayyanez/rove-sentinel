import { createRequire } from 'node:module';
import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const visited = new Map();

async function locate(name, from) {
  const req = createRequire(path.join(from, 'package.json'));
  let current;
  try { current = path.dirname(req.resolve(`${name}/package.json`)); }
  catch { current = path.dirname(req.resolve(name)); }
  for (;;) {
    try {
      const data = JSON.parse(await readFile(path.join(current, 'package.json'), 'utf8'));
      if (data.name === name) return { directory: await realpath(current), data };
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`Cannot locate package metadata for ${name}`);
    current = parent;
  }
}

async function visit(name, from) {
  const { directory, data } = await locate(name, from);
  const key = `${data.name}@${data.version}`;
  if (visited.has(key)) return;
  const names = (await readdir(directory)).filter((file) => /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(file)).sort();
  const notices = await Promise.all(names.map(async (file) => ({ file, text: await readFile(path.join(directory, file), 'utf8') })));
  if (!notices.length) throw new Error(`Missing license notice for ${key}`);
  visited.set(key, { name: data.name, version: data.version, license: data.license, notices });
  for (const dependency of Object.keys(data.dependencies || {})) await visit(dependency, directory);
  for (const dependency of Object.keys(data.optionalDependencies || {})) {
    try { await visit(dependency, directory); }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
}

for (const name of Object.keys(pkg.dependencies || {})) await visit(name, root);
const entries = [...visited.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`));
await writeFile(path.join(root, 'THIRD_PARTY_NOTICES.txt'), [
  'Rove Sentinel runtime dependency notices',
  'Generated from the installed dependency graph. Provider binaries are not redistributed.',
  ...entries.map((entry) => `\n${entry.name}@${entry.version} — ${entry.license}\n${'='.repeat(72)}\n${entry.notices.map(({ file, text }) => `${file}\n\n${text}`).join('\n')}`),
].join('\n'));
await writeFile(path.join(root, 'docs/dependencies.json'), `${JSON.stringify({
  schemaVersion: 1,
  directRuntimeDependencies: pkg.dependencies,
  packages: entries.map(({ notices, ...entry }) => ({ ...entry, licenseFiles: notices.map(({ file }) => file) })),
}, null, 2)}\n`);
process.stdout.write(`Recorded ${entries.length} runtime packages.\n`);
