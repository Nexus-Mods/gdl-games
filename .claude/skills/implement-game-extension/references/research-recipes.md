# Research recipes

Reusable, verified methods for the data a new game extension needs. All Nexus API calls take a
`NEXUS_API_KEY` (set in the environment). Examples use `solarpunk` (domain) / `8156` (game id).

## 1. Resolve the game (domain → id, name, Vortex support)

Guess the domain from the name: lowercase, drop spaces and punctuation
(`007: First Light → 007firstlight`, `Subnautica 2 → subnautica2`). Verify:

```sh
curl -s -H "apikey: $NEXUS_API_KEY" -H "User-Agent: gdl-games/1.0" \
  "https://api.nexusmods.com/v1/games/<domain>.json"
# → { "id": 8156, "name": "Solarpunk", "domain_name": "solarpunk", "mods": 5, ... }
```

If it 404s or the name doesn't match, ask the user for the correct domain. The numeric `id` is the
**game id** used for the artwork URL.

## 2. Store ids (verified against Vortex's matching code)

Vortex matches each store on a specific field — using the wrong value silently breaks auto-detection
on that store only (Steam still works). Get each right:

- **steam** — the numeric Steam app id. If the game is installed: read
  `steamapps/appmanifest_<appid>.acf` (`"appid"`). Otherwise the Steam store URL
  (`store.steampowered.com/app/<id>/`) or SteamDB.
- **epic** — the Epic manifest **`AppName`** (the artifact id), NOT the CatalogItemId or offer id.
  Vortex's `EpicGamesLauncher` sets the entry's `appid = manifest.AppName`. Get it from egdata:
  ```sh
  curl -s "https://api.egdata.app/autocomplete?query=<name>"        # → { id (offer), namespace, title }
  curl -s "https://api.egdata.app/sandboxes/<namespace>/assets"     # → artifactId (Windows) = the AppName
  ```
- **xbox** — the package **Identity Name** (the part before `_<publisherhash>`), NOT the `9N…` store
  id. Vortex's `gamestore-xbox` derives `appid` from the appsFolder key prefix. Find the `9N…` id
  from `xbox.com/games/store/<slug>/<9N…>`, then:
  ```sh
  curl -s "https://displaycatalog.mp.microsoft.com/v7.0/products/<9N-id>?market=US&languages=en-us&fieldsTemplate=details"
  # → Product…Packages[].PackageIdentityName, e.g. "rokapublish.Solarpunk"
  ```

Steam is usually enough to ship; add epic/xbox when the ids are confirmed. A wrong/guessed epic or
xbox id degrades gracefully (that store just won't auto-detect) — never invent one; omit instead.

## 3. Game artwork image (for `gameart.webp`)

The new Nexus site derives game artwork from `game id` + an `artworkSchema` enum (`V1`/`V2`):

```sh
curl -s -H "apikey: $NEXUS_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"{ game(domainName:\"<domain>\"){ id artworkSchema } }"}' \
  "https://api.nexusmods.com/v2/graphql"
```

Build the **hero** URL (`images.nexusmods.com`, host serves WebP despite the `.jpg` path):

- `V2` → `https://images.nexusmods.com/images/games/v2/{id}/hero.jpg`   (also `tile.jpg`, `thumbnail.jpg`)
- `V1` → `https://images.nexusmods.com/images/games/4_3/tile_{id}.jpg`  (legacy)

The `hero` is a wide banner (~1920×620). Crop/resize it to a **640×360** 16:9 WebP to match the
other extensions. `sharp` isn't a repo dependency — install it on demand (as done for Solarpunk):

```sh
TMP="$HOME/.tmp-imgconv"; mkdir -p "$TMP"; (cd "$TMP" && echo '{"name":"x","private":true}' > package.json && npm i sharp@^0.33 --no-audit --no-fund)
curl -s -o "$TMP/src.jpg" "https://images.nexusmods.com/images/games/v2/<id>/hero.jpg"
node -e "require('$TMP/node_modules/sharp')('$TMP/src.jpg').resize(640,360,{fit:'cover',position:'centre'}).webp({quality:82}).toFile('games/<domain>/gameart.webp').then(i=>console.log(i)).catch(e=>{console.error(e);process.exit(1)})"
rm -rf "$TMP"
```

Run the `node -e` from the repo root, or write it to a temp `.mjs` if quoting fights the shell
(bash mangles multi-line `-e`). Verify with `file games/<domain>/gameart.webp` → `640x360`.

## 4. Nexus publish ids for the `nexus:` block

- `modId` = the **site/extension id** the user provided (the extension's mod page on
  `nexusmods.com/site`, i.e. game `site` / id `2295`).
- `fileGroupId` = the upload file-group on that mod page. Try to resolve it from the site mod via the
  v2 GraphQL (`modFiles`/file groups for game `site`); if it can't be resolved, ask the user (they
  see it on the Nexus upload page).
- `displayName` = `"<Game Name> Support for Vortex"`.

GDL rejects `0`/placeholder nexus ids at build time, and CI's release guard refuses to publish a
stub — so only add the `nexus:` block once real ids are in hand.

## 5. Corpus mechanics

`tests.corpus: nexus` + `gdl test:corpus --fetch` pulls each published mod's **file-listing
manifest** (not the archive) for the game's `nexusDomain` from the Nexus API into
`games/<id>/tests/cache/` (git-ignored), then runs every installer rule + `validators` against
them. Needs `NEXUS_API_KEY`. Local-only — not wired into CI.

Run it through Nx (note the target is `test-corpus` with a hyphen — Nx target names can't contain
`:` — and `--fetch` needs the `-- ` passthrough):

```sh
pnpm nx run <id>:test-corpus -- --fetch
```

A clean run reports `N matched, 0 unmatched, 0 failed` and `validators: … passed`.

## 6. Template map (copy the closest existing game)

- **UE5 + UE4SS, with hooks** (mods.txt regen / non-UTF-8 version file) → `games/subnautica2`
  (has `src/hooks.ts`, `discovery.version: { hook }`).
- **UE5, pak + ReShade + loose-DLL, no hooks** → `games/solarpunk` (pak / pak-iostore / pak-alt /
  content-folder / root / ue4ss-injector / reshade / native-dll installers + validators).
- **File-based game-version discovery** → `games/gothic1remake` / `games/paralives`
  (`discovery.version: { file: "…", regex: "…" }`).
- **Non-Unreal engine** → research the game's mod format (loader, mod folder, file types) and build
  `modTypes` + `installers` from scratch; still use the corpus loop to validate against real mods.

Key Vortex/runtime facts to keep in mind: `testSupported` honors both `when` and `unless`
(GDL ≥ ccac820); a mod that has both a `.pak` and a `.utoc` routes to `pak` (not `pak-iostore`,
whose `unless: **/*.pak` excludes it).
