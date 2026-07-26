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
 *   2. every game.yaml's nexus.displayName matches the pattern the Nexus publish API
 *      accepts — a violation only fails after merge, once the ledger tag already exists
 *   3. no doc hardcodes an absolute path — they break on other checkouts
 *   4. relative links in the docs we own actually resolve
 *
 * Deliberately NOT checked: whether each game.yaml carries a header comment block. New games
 * get one (the skill's Step 3b covers it), but mechanically enforcing it across every existing
 * game turns a documentation habit into a compliance chore — and a guard that fires on
 * something nobody intends to fix is a guard people learn to ignore.
 *
 * Usage: node tools/audit-docs.mjs
 * Exits non-zero with a list of problems.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const MAP = '.claude/skills/implement-game-extension/references/research-recipes.md';
const DOCS = [
  'README.md',
  'CLAUDE.md',
  'docs/corpus-manifests.md',
  'docs/published-extension-stability.md',
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

// --- 2. nexus.displayName matches what the Nexus publish API accepts -------
//
// The mod-file-version endpoint validates `name` against this pattern and returns a 422
// otherwise. displayName is release metadata read from game.yaml by CI, not compiled into
// the bundle, so build/test/corpus all pass and the failure only appears after merge —
// after the ledger tag has already been created. Halo shipped a colon and broke on it.

const DISPLAY_NAME_OK = /^[a-zA-Z0-9 _'().-]+$/;

for (const g of games) {
  const rel = `games/${g}/game.yaml`;
  const m = read(rel).match(/^\s+displayName:\s*(.+?)\s*$/m);
  if (!m) continue;                                  // no nexus: block yet — fine
  const value = m[1].replace(/^["']|["']$/g, '');
  if (!DISPLAY_NAME_OK.test(value)) {
    const bad = [...new Set(value.split('').filter(c => !DISPLAY_NAME_OK.test(c)))].join(' ');
    problems.push(`${rel}: nexus.displayName "${value}" contains character(s) [${bad}] that the `
      + `Nexus publish API rejects (must match ${DISPLAY_NAME_OK.source}) — publishing will 422`);
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
