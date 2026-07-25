# Corpus state — Halo: Campaign Evolved

`tests/cache/` here is **not** produced by `test:corpus --fetch`. Every mod on this game was
uploaded after Nexus stopped generating file-preview manifests (~11 June 2026), so `--fetch` returns
404 for all of them and routes nothing while still exiting 0.

The listings were generated from the archives instead:

```sh
node tools/corpus/list-archive.mjs --domain halocampaignevolved --game-id 9685 --all \
  --out games/halocampaignevolved/tests/cache
pnpm nx run halocampaignevolved:test-corpus        # note: no --fetch
```

See [`docs/corpus-manifests.md`](../../../docs/corpus-manifests.md). `tests/cache/` is gitignored,
so re-run the command above to reproduce it.

## Coverage as of 2026-07-25

`39 listed / 41 mods` → **34 matched, 5 unmatched, 0 failed**; **30 validators passed**.

Unmatched, all intentional — nothing a mod manager can deploy:

| Mod | Content | Why |
|---|---|---|
| 7 | `Comet/Comet.exe` | standalone difficulty-editor tool |
| 10 | `.usmap` | asset mapping file for FModel, not a mod |
| 23 | `.ahk` scripts | AutoHotkey, runs outside the game |
| 30 | `.ps1` / `.cmd` | PowerShell FPS patcher |
| 39 | `.sav` files | save game, belongs in the save directory |

Not listed:

- **Mod 27** — a self-extracting `.exe` installer, skipped by the tool (no archive to read).
- **Mod 38** — Nexus returns `403 "This file has been quarantined"`. A moderation state on an
  otherwise-published mod, not a coverage gap.

Every matched category is mirrored by a `tests.cases` entry in `game.yaml`, with the mod id noted.
Those cases — not this cache — are the durable regression guard, since CI never runs the corpus.
