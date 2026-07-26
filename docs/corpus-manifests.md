# Corpus testing: manifests, the silent-pass trap, and the offline workaround

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
3. That file's **`uri`** becomes a manifest URL:
   `${NEXUS_FILE_META}/${gameId}/${modId}/${encodeURIComponent(uri)}.json`
   where `NEXUS_FILE_META = https://file-metadata.nexusmods.com/file/nexus-files-s3-meta`
   (`gdl/src/nexus/client.ts:3`, `:80-87`).
4. The manifest — a recursive `{name, path, type, children|size}` tree — is cached to
   `games/<id>/tests/cache/${gameId}_${modId}_${fileId}_${safe(uri)}.json`
   (`fetch-corpus.ts:60`).
5. Every cached listing is replayed through the `installers` and `validators`.

The manifest is a **file listing only** — the corpus never sees archive contents
(`gdl/src/corpus/archive.ts:20`). That's enough to test routing, and it's why listings can be
reconstructed by other means (see [the workaround](#the-workaround-listing-archives-without-manifests)).

The manifests are static artifacts generated asynchronously by Nexus. They are **not** guaranteed to
exist for a given upload.

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

Real example: `games/moonlightpeaks` has **68 published mods** and an **empty** `tests/cache/`. Its
corpus run prints 68 `✖` lines and exits 0.

If the code cites above no longer match, the trap may have been fixed — verify before relying on
this section.

## The UUID-uri outage (current, known)

Since **~11 June 2026**, Nexus returns a new `uri` shape and no manifests exist for it:

| `uri` shape | example | manifest |
|---|---|---|
| legacy filename | `Solarpunk UE4SS Developer-4-1-0-1-1780981537.zip` | **200** |
| UUID path | `03/c9/aa/03c9aae5-1b33-4536-9b79-b5bef18a9222` | **404** |

The switchover was sharp: last legacy-uri upload 04:23 UTC, first UUID-uri upload 10:47 UTC, same
day. The clearest demonstration is a single mod that has both — `solarpunk` (game 8156) mod 4 —
where the legacy file resolves and the UUID file 404s.

Key points:

- This affects **every upload since that date on any game**, not just newly-added games. Older games
  keep partial coverage only because their pre-June uploads still resolve.
- It is **not** a `gdl` bug and **not** an auth problem. The metadata host ignores credentials
  entirely — a working URL returns 200 with no API key at all. Percent-encoded vs literal slashes
  both 404, so it isn't `encodeURIComponent` mangling the path either.
- `modFileContents` (v2 GraphQL) looks like a replacement — it has `filePath`/`fileName`/
  `fileExtension` — but returns `totalCount: 0` for every game tried, including ones whose S3
  manifests work. Not currently a substitute.
- This is a **known issue at Nexus**, tracked internally. **Recheck whether it's fixed** before
  reaching for the workaround.

## The workaround: listing archives without manifests

The archives themselves are fine — only the manifests are missing. You can still get **real** file
listings, which is what the corpus actually needs.

Use the committed tool:

```sh
node tools/corpus/list-archive.mjs --domain <domain> --game-id <id> --all \
  --out games/<id>/tests/cache
pnpm nx run <id>:test-corpus          # NOTE: no --fetch — routes the local cache
```

See [`tools/corpus/README.md`](../tools/corpus/README.md). How it works:

1. **Signed CDN links** — `GET /v1/games/<domain>/mods/<modId>/files/<fileId>/download_link.json`
   with an `apikey` header returns direct CDN URLs (requires a **premium** account). The CDN path
   uses the *same* UUID key that 404s on the metadata host.
2. **Range reads** — the CDN honours `Range` (`206 Partial Content`). For a `.zip`, read the last
   ~96 KB, find the End Of Central Directory signature `PK\x05\x06`, then walk the central directory
   (`PK\x01\x02`) for the complete file listing. This got **109 entries out of a 2 GB archive from a
   64 KB read**. Only `.7z`/`.rar` need a full download.
3. **Emit manifest-shaped JSON** into `tests/cache/` using the same `{name, path, type, children}`
   tree gdl's `flattenManifest` expects (root: `name: ""`, `path: ""`, `type: "directory"`), with
   filenames matching what `--fetch` would write. Then run `test-corpus` **without** `--fetch`.

> **Gotcha that cost real debugging time:** `7z l -ba -slt` prints entries with **no header line**.
> Do **not** skip the first `Path = ` entry. Doing so silently reports single-file archives as
> *empty*, which nearly hid an entire mod category (five `Engine.ini` mods) on
> `halocampaignevolved`. Also filter out `Folder = +` rows so directories aren't treated as files.

Worked example: `games/halocampaignevolved/tests/cache/` (37 hand-generated listings) →
`32 matched, 5 unmatched, 0 failed`. See `games/halocampaignevolved/tests/README.md`.

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
