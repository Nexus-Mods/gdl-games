// Run a GDL CLI command against every game under games/*.
//
// Each game is just a folder containing a game.yaml (plus gameart.webp). There is
// no per-game package.json: this script discovers the games and invokes the shared
// gdl CLI (gdl/dist/cli.js) once per game, with cwd set to the game folder.
//
//   node scripts/run-gdl.mjs build           # build every game
//   node scripts/run-gdl.mjs package         # package every game
//   node scripts/run-gdl.mjs test:corpus --fetch
//
// Extra args after the command are forwarded to the CLI.

import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(repoRoot, 'gdl', 'dist', 'cli.js');
const gamesDir = join(repoRoot, 'games');
const args = process.argv.slice(2);

if (args.length === 0) {
  console.error('usage: node scripts/run-gdl.mjs <gdl-command> [args...]');
  process.exit(2);
}

if (!existsSync(cli)) {
  console.error(`GDL CLI not found at ${cli}\nRun \`pnpm init-gdl\` to build the shared toolchain first.`);
  process.exit(1);
}

const games = existsSync(gamesDir)
  ? readdirSync(gamesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && existsSync(join(gamesDir, d.name, 'game.yaml')))
      .map((d) => d.name)
      .sort()
  : [];

if (games.length === 0) {
  console.log('no games found under games/* (each game needs a game.yaml)');
  process.exit(0);
}

let failed = 0;
for (const game of games) {
  console.log(`\n→ ${game}: gdl ${args.join(' ')}`);
  const res = spawnSync(process.execPath, [cli, ...args], {
    cwd: join(gamesDir, game),
    stdio: 'inherit',
  });
  if (res.status !== 0) {
    failed += 1;
    console.error(`✖ ${game} failed (exit ${res.status ?? 'signal'})`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} of ${games.length} game(s) failed`);
  process.exit(1);
}
