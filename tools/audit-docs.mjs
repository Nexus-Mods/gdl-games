#!/usr/bin/env node
/**
 * audit-docs.mjs — guard the repo's own documentation against drifting out of date.
 *
 * The `implement-game-extension` skill once documented a corpus workflow that had stopped
 * working, and the knowledge was rediscovered from scratch weeks later. These checks are
 * cheap and catch that class of rot:
 *
 *   1. every games/<id>/ appears in the skill's template map (and the map names no game
 *      that doesn't exist)
 *   2. every games/<id>/game.yaml opens with a `#` header comment block
 *   3. no doc hardcodes an absolute path (e.g. C:\... ) — they break on other checkouts
 *   4. relative links in the docs we own actually resolve
 *
 * Usage: node tools/audit-docs.mjs
 * Exits non-zero with a list of problems.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MAP = '.claude/skills/implement-game-extension/references/research-recipes.md';
const DOCS = [
  'README.md',
  'CLAUDE.md',
  'docs/corpus-manifests.md',
  'tools/corpus/README.md',
  '.claude/skills/implement-game-extension/SKILL.md',
  MAP,
];

const problems = [];
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

// --- 1. template map covers exactly the games that exist -------------------

const games = readdirSync(join(ROOT, 'games'))
  .filter(n => existsSync(join(ROOT, 'games', n, 'game.yaml')))
  .sort();

const mapText = read(MAP);
for (const g of games) {
  if (!mapText.includes(`games/${g}\``)) {
    problems.push(`${MAP}: template map does not mention games/${g} — add it or exclude it explicitly`);
  }
}
for (const m of mapText.matchAll(/games\/([a-z0-9]+)`/g)) {
  if (!games.includes(m[1])) {
    problems.push(`${MAP}: template map references games/${m[1]}, which does not exist`);
  }
}

// --- 2. every game.yaml has a header comment block -------------------------

for (const g of games) {
  const rel = `games/${g}/game.yaml`;
  // Look past `gdl:` / `version:` for a run of comment lines before the first section.
  const lines = read(rel).split(/\r?\n/).slice(0, 40);
  const firstSection = lines.findIndex(l => /^[a-z]+:/.test(l) && !/^(gdl|version):/.test(l));
  const head = lines.slice(0, firstSection === -1 ? lines.length : firstSection);
  const commentLines = head.filter(l => l.trim().startsWith('#')).length;
  if (commentLines < 2) {
    problems.push(`${rel}: missing a header comment block (what the game is, engine, `
      + `supported mod types). See games/solarpunk/game.yaml.`);
  }
}

// --- 3. no absolute paths in docs -----------------------------------------

for (const rel of DOCS) {
  const text = read(rel);
  for (const m of text.matchAll(/[A-Za-z]:\\\\?[A-Za-z0-9_\\/-]{2,}/g)) {
    // %LOCALAPPDATA%-style illustrations are fine; drive letters are not.
    problems.push(`${rel}: hardcoded absolute path "${m[0]}" — use a repo-relative path`);
  }
}

// --- 4. relative links resolve --------------------------------------------

for (const rel of DOCS) {
  const text = read(rel);
  for (const m of text.matchAll(/\]\((\.\.?\/[^)#]+)/g)) {
    const target = resolve(ROOT, dirname(rel), m[1]);
    if (!existsSync(target)) problems.push(`${rel}: broken link → ${m[1]}`);
  }
}

// --- report ---------------------------------------------------------------

if (problems.length) {
  console.error(`audit-docs: ${problems.length} problem(s)\n`);
  for (const p of problems) console.error(`  ✖ ${p}`);
  console.error('\nThese docs go stale silently — please fix rather than suppress.');
  process.exitCode = 1;
} else {
  console.log(`audit-docs: ok (${games.length} games, ${DOCS.length} docs checked)`);
}
