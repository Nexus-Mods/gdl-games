# Corpus testing: manifests and the silent-pass trap

The corpus loop is how a game extension proves it routes **real** mods, not invented ones. This doc
is the single source of truth for how it works, how it fails, and what to do when it can't run.

Read this before trusting a `test-corpus` result.

- **DSL syntax** (`modTypes`, `installers`, `take`/`anchor`/`placeAt`, predicates, built-in facts) →
  [`gdl/README.md`](../gdl/README.md)
- **Setup, Nx targets, releasing** → [`README.md`](../README.md)
- **Authoring a new game end-to-end** → the `implement-game-extension` skill

## How it works

With `tests.corpus: nexus` in `game.yaml`:

1. `fetchPublishedModIds(domain)` lists every published mod (paginated GraphQL).
2. For each mod, `modFiles(modId, gameId)` returns its files; `pickDefaultFile` picks the newest
   `MAIN` file, else the newest of any category (`gdl/src/nexus/fetch-corpus.ts:22-27`).
3. That file's `fileId` is looked up on the v3 API, whose response carries the manifest's URL in
   `manifest_url`:
   `GET https://api.nexusmods.com/v3/games/<domain>/mod-file-versions/<fileId>` with an `apikey`
   header (`fetchArchiveManifest` in `gdl/src/nexus/client.ts`). The v3 id is the same `fileId`
   that v1 and GraphQL use.
4. The manifest at `manifest_url` is cached to
   `games/<id>/tests/cache/${gameId}_${modId}_${fileId}_${safe(uri)}.json`
   (`fetch-corpus.ts:60`). The manifest host (`mod-file-manifests.nexusmods.com`) is public, so
   gdl doesn't send the key there.
5. Every cached listing is replayed through the `installers` and `validators`.

That one route covers every upload, old and new. It needs a normal API key, not a premium one.
Nothing downloads an archive, and no second API is involved.

### What a manifest holds

```json
{
  "version": 1,
  "archive":  { "size": 33210786, "hashes": { "SHA1": "…", "SHA256": "…", "SHA512": "…", "MD5": "…", "CRC32": "…", "XXH64": "…", "XXH3_64": "…" } },
  "repacked": { "size": 25627180, "hashes": { … } },
  "files": [
    { "file_path": "ue4ss/Changelog.md", "file_size": 63174, "file_hashes": { "SHA1": "…", "MD5": "…", … } }
  ]
}
```

A flat list of every file with its real size and seven hashes, plus the same for the uploaded
archive and Nexus's repacked copy. The corpus reads only `file_path` and drops `__MACOSX/` entries
(`flattenManifest`). It never sees archive contents (`gdl/src/corpus/archive.ts`).

`readManifestEntries` also reads the older `{name, path, type, children}` tree format, so a cache
written before the switch still replays.

### Coverage, checked 2026-10-20

Every file of every published mod on the 12 games in this repo with a Nexus page: 12,440 files
across 2,885 mods.

- v3 returned `manifest_url` for all 12,440.
- 12,394 manifests loaded. The 46 that 404'd are 34 bare `.exe` installers, 3 files with no
  extension, 8 zero-byte `.zip` uploads and 1 real 34 KB zip (`thebloodofdawnwalker` mod 131, file
  348). None of those is a mod the corpus could route anyway, bar the last.
- 1,624 of the 1,688 pre-June files that still had an old-style manifest list exactly the same
  paths. Of the 64 that differ, 48 are the old format listing an empty directory as a file, 14 are
  `__MACOSX/` entries the old format left out (gdl drops them now), and 1 is a mod with Cyrillic
  filenames that come through garbled (`007firstlight` mod 52, file 233).

The API says `manifest_url` is null when there is no manifest, and may briefly 404 while a new
upload is still processing. gdl reports both as a per-mod error, so they show up as `✖` lines.

## The silent-pass trap — read this before believing a green run

> **A green `test-corpus` does not mean your installers work. It can mean nothing ran at all.**

Two behaviours combine badly:

- `fetch-corpus.ts:69-75` catches **every** per-mod error and reports it as a progress event.
  `fetchCorpus` then resolves normally — a 100% failure rate is not an error.
- `test-corpus.ts:175-178` prints `no archives in tests/cache/ — nothing to do` and bare-`return`s,
  so the process **exits 0**.

Failures render as a single `✖ mod-<id>` line each, which scrolls away and is easy to miss if you
tail the output.

**Rules:**

1. `no archives in tests/cache/ — nothing to do` is a **FAILURE**, not a pass.
2. `N matched, 0 unmatched` is meaningless unless **N is close to the real mod count**. Get the real
   count from `mods` in `GET https://api.nexusmods.com/v1/games/<domain>.json`.
3. Never conclude "corpus green" from an exit code, or from a tailed log. Read the
   `summary: N matched, M unmatched, K failed, T total` line and reconcile `T` yourself.
4. When reporting results, state how many mods actually routed — not just "matched".

Real example: during the 2026 manifest outage (see [History](#history-the-june-2026-outage)),
`games/moonlightpeaks` had **68 published mods** and an **empty** `tests/cache/`. Its corpus run
printed 68 `✖` lines and exited 0.

If the code cites above no longer match, the trap may have been fixed — verify before relying on
this section.

## History: the June 2026 outage

Before October 2026, gdl built the manifest URL from the GraphQL file `uri` on a different host,
`https://file-metadata.nexusmods.com/file/nexus-files-s3-meta/<gameId>/<modId>/<uri>.json`, which
returned a `{name, path, type, children|size}` tree with rounded sizes and no hashes.

From about 11 June 2026, new uploads got a UUID-style `uri` (`03/c9/aa/03c9aae5-…`) and that host
404'd for all of them, on every game. Until v3 `manifest_url` replaced it, the repo listed archives
by hand with `tools/corpus/list-archive.mjs`: a premium download link, then a `Range` read of each
zip's central directory, or a full download for `.7z`/`.rar`. That tool has been deleted. Its
listings wrote `size: "1 KB"` for every file, so treat any old cache with those sizes as
placeholder data and re-fetch.

Game comments written during the outage say `--fetch` doesn't work. That is no longer true.

## Corpus evidence is never committed

`.gitignore` ignores `**/tests/cache/`. That is deliberate, but it has a consequence worth stating:

**`tests.cases` in `game.yaml` is the only durable regression guard.** A reviewer cannot reproduce
your corpus run, and CI never runs it (corpus is local-only — see the root README).

So treat the corpus as a **discovery tool**, not the test:

- Use it to find every real mod category and catch mis-routes.
- **Promote every category it reveals into a `tests.cases` entry** using the real archive shape.
- Where a rule has an `unless` guard, add a case that would fail if the guard were removed.

Precedent for documenting a shortfall in-place: `games/assassinscreedblackflagresynced/game.yaml:162-165`
records that its uploads had no file-preview, so its `tests.cases` are the real guard. Do the same
whenever coverage is incomplete — a silent gap reads as an oversight.

## Bounding a fetch

A large catalogue will pull thousands of manifests. `test:corpus` accepts `--limit N` and
`--mods 1,2,3` — see `gdl/README.md`. Via Nx, pass them after `--`:

```sh
pnpm nx run <id>:test-corpus -- --fetch --limit 100
pnpm nx run <id>:test-corpus -- --fetch --mods 9,22,35
```

## Uploads that legitimately never match

Not every upload is mod-manager content. These should stay unmatched, and the reason belongs in a
`game.yaml` comment:

- **Standalone tools** — a bundled `.exe` (e.g. a difficulty editor)
- **Scripts run outside the game** — `.ahk` (AutoHotkey), `.ps1`/`.cmd` patchers
- **Save files** — `.sav`, which belong in the save directory
- **Modding resources** — `.usmap` mapping files for FModel

Also: Nexus can return `403 "This file has been quarantined and is not available for download."`
That's a moderation state on an otherwise-published mod — **not** a coverage gap. Note it and move
on.

The bar for "intentionally unsupported" is otherwise high. When in doubt, support it.
