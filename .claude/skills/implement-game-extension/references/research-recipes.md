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

Vortex now uses the **tile** artwork. Download it and save it **as-is** — no cropping, resizing, or
re-encoding. The tile is already the right shape and format (the host serves WebP despite the `.jpg`
path), so `sharp` is no longer needed.

The bundled `gameart.webp` is only a **fallback**: Vortex primarily loads tile art from the site at
runtime, and falls back to the bundled file when the site is unreachable (offline, API down, or
before the art is cached). So it just needs to be the correct tile — don't spend time perfecting it,
and don't block a release on it.

```sh
curl -s -o "games/<domain>/gameart.webp" \
  "https://images.nexusmods.com/images/games/v2/<id>/tile.jpg"
```

`<id>` is the numeric game id from recipe §1. Verify it downloaded a real image, not an error page:

```sh
file games/<domain>/gameart.webp   # → RIFF ... Web/P image ... e.g. 400x600
```

Notes:

- The tile is **portrait** (400×600 / 2:3 on current games) — do **not** crop it to 16:9. Older
  extensions in this repo carry a legacy 640×360 hero crop; new games should use the tile as-is.
  Those older files don't need retrofitting — they're fallback-only (see above).
- Sibling images on the same path, if you ever need them: `hero.jpg` (wide banner, ~1327×620) and
  `thumbnail.jpg` (80×80). Vortex wants the tile.
- Legacy `V1` games (rare) use `https://images.nexusmods.com/images/games/4_3/tile_{id}.jpg`. The
  `game{ id artworkSchema }` GraphQL query tells you which schema a game uses if a URL 404s.

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
manifest** (not the archive) into `games/<id>/tests/cache/` (git-ignored), then runs every installer
rule + `validators` against them. Needs `NEXUS_API_KEY`. Local-only — not wired into CI.

Run it through Nx (the target is `test-corpus` with a hyphen — Nx target names can't contain `:` —
and flags need the `-- ` passthrough). `--limit N` and `--mods 1,2,3` bound a large catalogue:

```sh
pnpm nx run <id>:test-corpus -- --fetch --limit 100
```

> **A green run can be completely vacuous** — an all-failed fetch and an empty cache both exit 0.
> Always reconcile the `T total` in the summary against the `mods` count from
> `/v1/games/<domain>.json`. Mechanics, the current manifest outage, and the offline workaround:
> [`docs/corpus-manifests.md`](../../../../docs/corpus-manifests.md).

## 6. Template map (copy the closest existing game)

Verified 2026-07-25. Keep this in sync — `tools/audit-docs.mjs` checks that every game is listed.

| Closest match | Template | Notes |
|---|---|---|
| UE5 + UE4SS, **with hooks** | `games/subnautica2` | `src/hooks.ts` + `discovery.version: { hook }` and `events.did-deploy` (mods.txt regen). No ReShade/native-dll rules. |
| UE5 pak + ReShade + loose DLL | `games/solarpunk` | The fullest UE5 set: `pak`, `pak-iostore`, `pak-alt`, `logicmods`, `ue4ss-injector`, `ue4ss-lua` + `-enabled` + `-bare`, `reshade`, `native-dll`, `root`, `content-folder`. |
| UE5 **+ config/media mods** | `games/halocampaignevolved` | Solarpunk's set **plus** `config-ini` (`${appDataLocal}` user config) and `menu-movie` (asset replacement). Use this when mods aren't all paks — see SKILL.md Step 4. |
| UE5, **unreleased** game | `games/outward2` | Shows the `# UNVERIFIED` convention for an exe not yet confirmed against a shipping build, and a deferred `nexus:` block. |
| UE, file-based version + hooks | `games/gothic1remake` | Also has `src/hooks.ts` (`events.did-deploy`) **and** file-based `discovery.version`. Adds `native-gothic-mod`, `ue4ss-injector-repack`. |
| Non-UE, LocalLow mod folder | `games/paralives` | `${appDataLocalLow}` mod folder, file-based `discovery.version`, settings-override + overlay installers. |
| Non-UE, **minimal** (Unity/BepInEx) | `games/moonlightpeaks` | Smallest complete game: 2 installers (`bepinex`, `root`), 1 validator. Copy its *structure* — but it has **zero comments**, so don't copy its documentation habits (see SKILL.md Step 3b). |
| Non-UE, proprietary engine | `games/assassinscreedblackflagresynced` | Anvil: `.forge`/`.asi`/ReShade routing. Also the precedent for documenting a catalogue the corpus can't route. |
| Non-UE, nested-exe layout | `games/007firstlight` | Glacier/RPKG; `executable` under `Retail/`. Also comment-free — structure only. |

Anything else non-Unreal: research the mod format (loader, mod folder, file types) and build
`modTypes` + `installers` from scratch, then validate against real mods via the corpus loop.

Key runtime facts: `testSupported` honors both `when` and `unless` (GDL ≥ ccac820); a mod carrying
both a `.pak` and a `.utoc` routes to `pak`, not `pak-iostore` (whose `unless: **/*.pak` excludes
it). Built-in facts available in `context` include `installPath`, `store`, `os`, `arch`, `version`,
`appDataLocal`, `appDataLocalLow` and `appDataRoaming` — see `gdl/README.md`.
