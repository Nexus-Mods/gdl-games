#!/usr/bin/env node
/**
 * changelog.mjs — derive the changelog text CI posts to a game's Nexus file page.
 *
 * The Nexus upload action accepts a `changelog` input (plus `mod_id`). Rather than keep a
 * hand-written file per game, the text is derived from git history: commit subjects between
 * the game's previous ledger tag and HEAD, scoped to that game's folder.
 *
 * Why path-scoping to games/<id> is sound, and why it's scoped that tightly:
 *   * Ledger tags are already per-game (`<id>-v<version>`), so the commit range is exact
 *     and needs no new state to track.
 *   * A release can only fire from a `version:` bump in games/<id>/game.yaml, so the
 *     release-worthy commit ALWAYS touches games/<id>. Path-scoping cannot miss it.
 *     (paralives 1.3.1 is the proof case: a gdl submodule fix and the version bump rode in
 *     the same commit, so the fix is still described by that commit's subject.)
 *   * Widening the pathspec to include gdl/ was the first instinct and is actively wrong —
 *     it put four unrelated games' commits into subnautica2's changelog, because a shared
 *     toolchain bump touches every game's history at once.
 *
 * Cross-game commits are a feature here, not a bug: `fix(subnautica2,solarpunk): …` touches
 * both folders and should appear on both games' pages.
 *
 * The output lands on a PUBLIC mod page and is effectively permanent — correcting it needs
 * another version bump — so housekeeping subjects are stripped rather than published, and
 * an all-filtered release falls back to a generic line instead of posting an empty changelog.
 *
 * Usage: node tools/changelog.mjs <game-id> [--from <tag>] [--to <ref>]
 * Prints the changelog to stdout (empty output is never printed; see FALLBACK).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const FALLBACK = 'Maintenance release — no user-facing changes.';

/**
 * Conventional-commit types that describe repo upkeep rather than anything a mod user would
 * notice. `chore` covers the bare "bump version to x.y.z" commits that would otherwise
 * produce a changelog restating the version number the page already shows.
 */
const NOISE_TYPES = new Set(['chore', 'docs', 'ci', 'test', 'build', 'style', 'refactor']);

/**
 * Subjects that carry no useful information for a reader even though they aren't
 * conventional-commit shaped. Matched case-insensitively against the whole subject.
 */
const NOISE_SUBJECTS = [
  /^update\s+mod\s*id$/i,
  /^bump\s+version/i,
  /^wip\b/i,
  /^merge\b/i,
];

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * The newest ledger tag for this game that is strictly older than `to`.
 *
 * Sorted with -v:refname, not creatordate: version order is the thing that defines "previous
 * release", and it keeps 0.10.0 ahead of 0.9.0 (lexical sort gets that backwards) while being
 * immune to a re-tag reordering creation dates.
 *
 * The tag for the version being released now usually does NOT exist yet — CI creates it in
 * the GitHub-release step — but this tolerates it existing (a re-run) by skipping any tag
 * that `to` is already at or behind.
 */
const previousTag = (id, to) => {
  let tags;
  try {
    tags = git(['tag', '-l', `${id}-v*`, '--sort=-v:refname']).split('\n').filter(Boolean);
  } catch {
    return null;   // no tags fetched (shallow clone) — caller degrades to the fallback
  }
  for (const tag of tags) {
    try {
      // Reachable from `to` and not equal to it => a genuine predecessor.
      const mergeBase = git(['merge-base', tag, to]).trim();
      const tagSha = git(['rev-parse', `${tag}^{commit}`]).trim();
      const toSha = git(['rev-parse', `${to}^{commit}`]).trim();
      if (tagSha !== toSha && mergeBase === tagSha) return tag;
    } catch {
      continue;   // tag not present locally / unrelated history
    }
  }
  return null;
};

/** Strip the `type(scope):` prefix so the public page reads as prose, not as git plumbing. */
const stripPrefix = (subject) =>
  subject.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');

/**
 * Drop the trailing "; bump to 1.2.0" bookkeeping that several commits append — the version
 * is already the headline of the file page.
 */
const stripBump = (text) =>
  text.replace(/[;,]\s*bump(?:\s+\w+)?\s+to\s+v?\d+[\w.\-]*\s*$/i, '').trim();

const isNoise = (subject) => {
  if (NOISE_SUBJECTS.some((re) => re.test(subject.trim()))) return true;
  const match = /^([a-z]+)(\([^)]*\))?!?:/i.exec(subject);
  return match ? NOISE_TYPES.has(match[1].toLowerCase()) : false;
};

/** Uppercase the first letter so stripped subjects read as sentences. */
const sentenceCase = (text) =>
  text ? text[0].toUpperCase() + text.slice(1) : text;

export const buildChangelog = (subjects) => {
  const lines = [];
  const seen = new Set();
  for (const subject of subjects) {
    if (isNoise(subject)) continue;
    const cleaned = sentenceCase(stripBump(stripPrefix(subject)));
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;   // same fix cherry-picked / re-landed
    seen.add(key);
    lines.push(`- ${cleaned}`);
  }
  return lines.length ? lines.join('\n') : FALLBACK;
};

const main = () => {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => !a.startsWith('--'));
  if (!id) {
    process.stderr.write('usage: node tools/changelog.mjs <game-id> [--from <tag>] [--to <ref>]\n');
    process.exit(2);
  }
  if (!existsSync(`games/${id}/game.yaml`)) {
    process.stderr.write(`no such game: games/${id}/game.yaml\n`);
    process.exit(2);
  }

  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };

  const to = flag('to') ?? 'HEAD';
  const from = flag('from') ?? previousTag(id, to);

  let subjects = [];
  try {
    const range = from ? `${from}..${to}` : to;
    // --no-merges: merge commits restate the PR title already covered by the commits below it.
    const args = ['log', '--no-merges', '--format=%s', range, '--', `games/${id}`];
    // Without `from` this would walk the entire history of the folder, which for a game's
    // first release is exactly right and for a shallow clone is all we have anyway.
    subjects = git(args).split('\n').filter(Boolean);
  } catch (err) {
    process.stderr.write(`warning: could not read git history (${err.message.trim()})\n`);
  }

  process.stdout.write(buildChangelog(subjects));
};

// Only run as a CLI; importing for tests must not execute main().
if (import.meta.url === `file://${process.argv[1]}` ||
    process.argv[1]?.endsWith('changelog.mjs')) {
  main();
}
