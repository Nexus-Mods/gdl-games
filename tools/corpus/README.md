# tools/corpus — archive listings without the Nexus manifest endpoint

## Why this exists

`gdl test:corpus --fetch` builds its corpus from Nexus **file-preview manifests**. Since
~11 June 2026 those manifests don't exist for uploads with UUID-style `uri`s, so `--fetch` returns
404 for every recent upload and the corpus routes **nothing** — while still exiting 0.

The archives themselves are still downloadable. `list-archive.mjs` reconstructs the same file
listings the corpus needs, so a new game can still be verified against real mods.

Full background, including the silent-pass trap: [`docs/corpus-manifests.md`](../../docs/corpus-manifests.md).

## Usage

```sh
# every published mod
node tools/corpus/list-archive.mjs --domain halocampaignevolved --game-id 9685 --all \
  --out games/halocampaignevolved/tests/cache

# specific mods
node tools/corpus/list-archive.mjs --domain halocampaignevolved --game-id 9685 --mod 9,22,35 \
  --out games/halocampaignevolved/tests/cache

# then route the local cache — NOTE: no --fetch
pnpm nx run halocampaignevolved:test-corpus
```

Requires `NEXUS_API_KEY` for a **premium** account (download links are premium-only). The game id
comes from `GET https://api.nexusmods.com/v1/games/<domain>.json`.

`.7z`/`.rar` archives need **7-Zip** (`7z`) on `PATH`; `.zip` archives don't.

## How it works

- `.zip` → HTTP `Range` request for the last ~96 KB, then walks the ZIP central directory. A few KB
  per archive regardless of size (109 entries out of a 2 GB archive from a 64 KB read). Falls back
  to a full download if the tail can't be parsed (e.g. ZIP64).
- `.7z`/`.rar` → full download, listed with `7z l -ba -slt`.
- `.exe` → **skipped**, not failed: a bare installer has nothing for the corpus to route.
- Output filenames match what `--fetch` writes, and the JSON is the same
  `{name, path, type, children}` tree `flattenManifest` consumes.

**Exits non-zero if any mod fails**, and prints `listed X / Y mods, N skipped, M failed` — the
deliberate opposite of the trap it works around. Never logs the API key or signed URLs.

A `403 "quarantined"` is Nexus moderation on an otherwise-published mod, not a coverage gap.

## Gotcha worth keeping

`7z l -ba -slt` prints entries with **no header line** — do not skip the first `Path = ` entry.
Doing so silently reports single-file archives as *empty*, which once hid an entire mod category
(five `Engine.ini` mods). Directory rows carry `Folder = +` and are filtered out.

## Sunset

**Delete this tool once Nexus restores manifests for UUID-style uris.** It exists only to work
around that outage. Check before using it: if `--fetch` populates `tests/cache/` normally, this is
dead code and should go, along with its references in `docs/corpus-manifests.md`, the root README,
and the `implement-game-extension` skill.
