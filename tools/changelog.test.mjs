import { describe, expect, it } from 'vitest';
import { buildChangelog } from './changelog.mjs';

// buildChangelog is the pure half of tools/changelog.mjs — the git range resolution is
// exercised against real history by running the CLI, but the filtering rules are what decide
// what lands on a public Nexus file page, so they're pinned here.

describe('buildChangelog', () => {
  it('strips the conventional-commit prefix so the page reads as prose', () => {
    expect(buildChangelog(['fix(solarpunk): add xboxLauncher so Game Pass copies can launch']))
      .toBe('Add xboxLauncher so Game Pass copies can launch');
  });

  it('keeps a cross-game commit — it legitimately describes both games', () => {
    expect(buildChangelog(['fix(subnautica2,solarpunk): add xboxLauncher so Game Pass copies can launch']))
      .toBe('Add xboxLauncher so Game Pass copies can launch');
  });

  it('drops the trailing "; bump to x.y.z" bookkeeping', () => {
    expect(buildChangelog(['feat(halocampaignevolved): Xbox/Game Pass launch + per-store executable; bump to 1.2.0']))
      .toBe('Xbox/Game Pass launch + per-store executable');
  });

  it('filters housekeeping types', () => {
    const subjects = [
      'chore(subnautica2): bump version to 1.5.0',
      'docs(halocampaignevolved): record the Xbox package identity research',
      'ci: cache pnpm store',
      'test(solarpunk): add corpus case',
      'fix(paralives): add setup.ensureDirs to fix "Deployment target unknown"',
    ];
    expect(buildChangelog(subjects))
      .toBe('Add setup.ensureDirs to fix "Deployment target unknown"');
  });

  it('filters non-conventional internal noise', () => {
    expect(buildChangelog(['update modId', 'Merge pull request #15 from x', 'WIP try something']))
      .toBe('Maintenance release — no user-facing changes.');
  });

  it('falls back rather than publishing an empty changelog', () => {
    expect(buildChangelog([])).toBe('Maintenance release — no user-facing changes.');
  });

  // The release-triggering commit itself. gothic1remake 2.2.0 published
  // "- Bump to 2.2.0" as its first entry: `release` wasn't a noise type, and the old
  // /^bump\s+version/ pattern didn't match `bump to 2.2.0` (no "version" word), nor did it
  // see the stripped form because isNoise only tested the raw subject.
  it('drops the release commit that triggers the publish', () => {
    expect(buildChangelog([
      'release(gothic1remake): bump to 2.2.0',
      'feat(gothic1remake): install UE4SS C++ mods and loose DLL plugins',
    ])).toBe('Install UE4SS C++ mods and loose DLL plugins');
  });

  it('drops a release-only publish rather than restating the version', () => {
    expect(buildChangelog(['release(halocampaignevolved): bump to 1.2.1']))
      .toBe('Maintenance release — no user-facing changes.');
  });

  // The site renders one entry per LINE and adds its own "Version x.y.z" heading, so a
  // leading dash appears as literal text.
  it('emits no bullet prefix', () => {
    const out = buildChangelog(['fix(x): do a thing', 'feat(x): add another']);
    expect(out).toBe('Do a thing\nAdd another');
    expect(out.split('\n').every((l) => !l.startsWith('-'))).toBe(true);
  });

  it('never publishes a bare version-bump-only release as an empty list', () => {
    // moonlightpeaks 1.0.3 is exactly this case in real history.
    expect(buildChangelog(['chore(moonlightpeaks): bump version to 1.0.3']))
      .toBe('Maintenance release — no user-facing changes.');
  });

  it('dedupes a fix that landed twice', () => {
    expect(buildChangelog([
      'fix(solarpunk): correct pak routing',
      'fix(solarpunk): Correct pak routing',
    ])).toBe('Correct pak routing');
  });

  it('preserves order and lists multiple changes', () => {
    expect(buildChangelog([
      'feat(x): add thing',
      'fix(x): fix other thing',
    ])).toBe('Add thing\nFix other thing');
  });

  it('handles a breaking-change marker', () => {
    expect(buildChangelog(['feat(x)!: drop legacy modType']))
      .toBe('Drop legacy modType');
  });

  it('keeps a subject with no conventional prefix at all', () => {
    expect(buildChangelog(['Correct the Engine.ini routing for nested folders']))
      .toBe('Correct the Engine.ini routing for nested folders');
  });
});
