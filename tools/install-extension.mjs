#!/usr/bin/env node
// Build a game extension and drop it into a local Vortex's plugins folder, so a
// change can be exercised in the real app without going through a release.
//
//   node tools/install-extension.mjs <game-id> [--dev|--prod] [--no-build]
//
// Vortex reads plugins/<dir>/info.json at startup, so the extension must be
// installed with Vortex closed, and Vortex restarted afterwards. The script
// refuses to run while Vortex is up rather than half-replacing a live plugin.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// A dev Vortex run from source (C:\src\Vortex) uses the @vortex/main appdata
// dir; an installed build uses Vortex/. They are separate instances with
// separate plugins and separate logs — installing into the wrong one looks like
// a silent no-op.
const VORTEX_DATA = {
  dev: join(process.env.APPDATA ?? '', '@vortex', 'main'),
  prod: join(process.env.APPDATA ?? '', 'Vortex'),
};

const args = process.argv.slice(2);
const gameId = args.find(a => !a.startsWith('--'));
const channel = args.includes('--prod') ? 'prod' : 'dev';
const skipBuild = args.includes('--no-build');

if (!gameId) {
  console.error('usage: node tools/install-extension.mjs <game-id> [--dev|--prod] [--no-build]');
  process.exit(2);
}

const gameDir = join(repoRoot, 'games', gameId);
if (!existsSync(join(gameDir, 'game.yaml'))) {
  console.error(`no games/${gameId}/game.yaml`);
  process.exit(2);
}

// Replacing files under a running Vortex leaves it with a half-old plugin and
// no error, so bail rather than produce a confusing test result.
const running = spawnSync('powershell', ['-NoProfile', '-Command',
  "(Get-Process | Where-Object { $_.ProcessName -match 'electron|vortex' } | Measure-Object).Count"],
  { encoding: 'utf8' });
if ((running.stdout ?? '').trim() !== '0') {
  console.error('Vortex (or an electron process) is running — close it first.');
  process.exit(1);
}

if (!skipBuild) {
  const build = spawnSync('pnpm', ['nx', 'run', `${gameId}:build`],
    { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (build.status !== 0) process.exit(build.status ?? 1);
}

const dist = join(gameDir, 'dist');
if (!existsSync(join(dist, 'info.json'))) {
  console.error(`no dist/info.json for ${gameId} — build first (drop --no-build)`);
  process.exit(1);
}

// Name the folder after info.json's id, which is what Vortex keys the extension
// on. gdl's extensionId() prefixes `game-` only for ids starting with a digit.
const info = JSON.parse(readFileSync(join(dist, 'info.json'), 'utf8'));
const pluginsDir = join(VORTEX_DATA[channel], 'plugins');
if (!existsSync(pluginsDir)) {
  console.error(`no plugins dir at ${pluginsDir} — is the ${channel} Vortex installed?`);
  process.exit(1);
}
const target = join(pluginsDir, info.id);

rmSync(target, { recursive: true, force: true });
mkdirSync(target, { recursive: true });
cpSync(dist, target, { recursive: true });

console.log(`installed ${info.id} v${info.version} -> ${target}`);
console.log('restart Vortex to pick it up');
