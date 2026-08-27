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

  **Layout research without an install — SteamCMD appinfo.** steamdb.info 403s scripted access
  (Cloudflare), but the data it renders is Steam's own appinfo, fetchable as JSON:
  ```sh
  curl -s "https://api.steamcmd.net/v1/info/<appid>"
  # → .data.<appid>.config.installdir, .config.launch{}, .depots{}, .common.releasestate
  ```
  For an unreleased game this is often the **first primary source for paths**: the launch config
  appears at preload (`releasestate: preloadonly`) or earlier, and its `executable` values are real
  paths inside the build. It reliably gives the `installdir` and the **default-branch launch exe**.

  **Do NOT take the project folder from a beta-branch launch path.** Internal `Development\…` /
  `Test\…` entries often expose a codename (`Test\<Codename>\Binaries\Win64\…`), and it is
  tempting to read the UE project folder off it. On starwarszerocompany that gave `Bruno`; the
  shipping folder is `SWZeroCompany`. Treat it as the codename only, and mark it `# UNVERIFIED`.

  Depot file lists are not available this way (and a preload depot is encrypted anyway).

  **Once the game is installed, the project folder is free and unambiguous:** UE ships
  `Manifest_NonUFSFiles_Win64.txt` at the install root, listing every non-packaged file. Its paths
  are all `Engine/…` or `<Project>/…`:
  ```sh
  head -6 "<install>/Manifest_NonUFSFiles_Win64.txt"
  ```
  Verify the config leaf at the same time — `%LOCALAPPDATA%/<Project>/Saved/Config/` (run the game
  once first; UE creates it on first launch) — and check `<Project>/Content/Paks/` for
  `global.utoc`, which is the better cross-store `requiredFiles` marker if xbox is added later.
- **epic** — the Epic manifest **`AppName`** (the artifact id), NOT the CatalogItemId or offer id.
  Vortex's `EpicGamesLauncher` sets the entry's `appid = manifest.AppName`. Get it from egdata:
  ```sh
  curl -s "https://api.egdata.app/autocomplete?query=<name>"        # → { id (offer), namespace, title }
  curl -s "https://api.egdata.app/sandboxes/<namespace>/assets"     # → artifactId (Windows) = the AppName
  ```
- **xbox** — three *different* values are needed, each consumed by a different Vortex subsystem. Getting
  one right does not get you the others, and each fails in its own way:

  | Value | Example | Used for | If wrong |
  |---|---|---|---|
  | **Identity Name** → `stores.xbox` | `Microsoft.198377053870B` | **Discovery** — `GameStoreHelper.findByAppId` matches the appsFolder key prefix | Game never auto-detects |
  | **`appExecName`** → `game.xboxLauncher` | `AppHaloCampaignEvolvedShipping` | **Launching** — becomes `shell:appsFolder\<family>!<appExecName>` | Silent non-launch (Vortex reports success) |
  | **exe path** → `game.executable` | `<Project>/Binaries/WinGDK/<Game>.exe` | **Process monitoring** + `getGameVersion` | Version silently `"0.0.0"`; running-detection can break |

  All three come from the same `displaycatalog` response (or the same `appxmanifest.xml`), so gather them
  in one pass. `requiredFiles` is a *fourth*, separate concern — see the WinGDK section below.

  The Identity Name is the part before `_<publisherhash>`, NOT the `9N…` store
  id. Vortex's `gamestore-xbox` derives `appid` from the appsFolder key prefix. Find the `9N…` id
  from `xbox.com/games/store/<slug>/<9N…>`, then:
  ```sh
  curl -s "https://displaycatalog.mp.microsoft.com/v7.0/products/<9N-id>?market=US&languages=en-us&fieldsTemplate=details"
  # → Product…Packages[].PackageIdentityName, e.g. "rokapublish.Solarpunk"
  ```
  Note the response's top-level key is **`Product`** (singular), not `Products`.

  **If there is no `Packages` array** — normal for an unreleased or just-released title, because no
  PC package has been published yet — fall back to
  `Product.DisplaySkuAvailabilities[].Sku.Properties.FulfillmentData.PackageFamilyName` and take the
  part before the `_`. Verified equivalent: Solarpunk's `FulfillmentData` gives
  `rokapublish.Solarpunk_6q4vfhsywtz4j`, matching the committed `rokapublish.Solarpunk`.

  **An autogenerated numeric identity is NOT a placeholder.** Identities come in two shapes: a
  product name (`rokapublish.Solarpunk`, `UnknownWorldsEntertainmen.Subnautica2`) and an
  autogenerated numeric one (`Microsoft.198377053870B`). Microsoft first-party titles routinely ship
  the numeric form **permanently** — Halo Infinite, shipped 2021 and years on Game Pass, is
  `Microsoft.254428597CFE2_8wekyb3d8bbwe`. (An earlier version of this recipe claimed numeric meant
  "pre-release placeholder"; that was wrong and cost a release cycle of unnecessary delay.)

  To settle it, **compare against a title you know already shipped** — resolve its store id and read
  its identity:
  ```sh
  curl -s "https://storeedgefd.dsx.mp.microsoft.com/v9.0/search?market=US&locale=en-us&query=<name>&deviceFamily=Windows.Desktop&mediaType=games"
  # → Payload.SearchResults[].ProductId — then feed that 9N… id to displaycatalog above
  ```
  Resolve ids this way rather than typing a `9N…` from memory: guessed ids 404, and "never invent
  ids" applies to research queries too.

  Cross-check with a second endpoint, which returns the family name directly:
  ```sh
  curl -s "https://storeedgefd.dsx.mp.microsoft.com/v9.0/products/<9N-id>?market=US&locale=en-us&deviceFamily=Windows.Desktop"
  # → Payload.PackageFamilyNames[]
  ```

#### `appExecName` — required for launching, fetchable from the same response

  Xbox games **cannot be launched without it.** `requiresLauncher` is the only path to
  `shell:appsFolder\…` in all of Vortex, and without it Vortex bare-spawns the exe: a GDK/MSIXVC title
  then fails licence validation and exits, which Vortex **reports as a successful launch**. So a missing
  `appExecName` is a silent non-launch.

  It is the package's `<Application Id="…">`, available from the catalog:
  ```sh
  curl -s "https://displaycatalog.mp.microsoft.com/v7.0/products/<9N-id>?market=US&languages=en-us&fieldsTemplate=details"
  # → Product.DisplaySkuAvailabilities[].Sku.Properties.Packages[].Applications[].ApplicationId
  #   Take the package whose PlatformDependencies[].PlatformName == 'Windows.Desktop'.
  ```
  Verified against extensions with known-correct hardcoded values: Palworld → `AppPalShipping`,
  Oblivion Remastered → `AppUEGameShipping`, Halo: Campaign Evolved → `AppHaloCampaignEvolvedShipping`.

  **Query the base game, not a bundle.** A bundle SKU (`IsBundle: true`) has an empty `Packages` array
  and no `PackageFamilyName`, so it yields nothing — e.g. `9PL9P3QZMRBM` is *Starfield Premium Edition*
  and returns no `ApplicationId`. Resolve the base-game product id and retry.

  **Never infer the value from the name.** `App<Project>Shipping` is a common UE convention, not a rule —
  Starfield's is simply `Game`. Vortex's own fallback chain is `entry.executionName` then the literal
  `"App"`, which is wrong for most games; that is why every shipped extension states it explicitly.

  **The authoritative source is the package's own `appxmanifest.xml`** — `Identity/@Name` for the store
  id, `Application/@Id` for `appExecName`, and `Application/@Executable` for the real exe path (all three
  values in one file). If you can get it from
  someone with the game (or from `Get-AppxPackage *<Name>*` / the `appsFolder` key on a real
  install), prefer it over any API. Exemplar: `games/halocampaignevolved/game.yaml`.

  A `package.manifest` (full file list, chunked) appears in the install dir **only while the game is
  downloading** and is deleted on completion — a useful windfall if someone is mid-install, but never
  plan around it. On a finished install, list the tree directly instead.

### The `Binaries/WinGDK` problem — and how to solve it

  Game Pass builds put the exe under `<Project>/Binaries/WinGDK`, not `Binaries/Win64`. A Win64-pinned
  `requiredFiles` therefore fails discovery on Xbox. **This does not mean you must omit the store.**

  The key fact, which unlocks it: **`requiredFiles` is a discovery fingerprint, not the launch
  target.** Vortex stats every entry and **all must exist** (no glob expansion), so it just answers
  "is this folder really this game?". Two consequences:

  - Adding the WinGDK path as a *second array entry* **breaks both stores** — neither install has the
    other's file. All-must-exist, not any.
  - `requiredFiles` need not be the exe at all. Point it at any file present at the **same relative
    path on every store**, and one static array serves all of them.

  For UE5 games a good candidate is **`<Project>/Content/Paks/global.utoc`** (or `global.ucas`): an
  IoStore container header which, unlike `pakchunk*-Windows` / `pakchunk*-WinGDK`, carries **no
  platform tag**.

  **It is not guaranteed — you must check the actual install.** `global.utoc` exists only if the game
  packages with **IoStore**:
  - **UE5** — IoStore is the default, so it's usually present. Verified on 3/3 real installs
    (halocampaignevolved, subnautica2, solarpunk). A project can still disable it
    (`bUseIoStore=false`) and ship plain `.pak` only.
  - **UE4** — usually **absent**. IoStore arrived in 4.27 as opt-in; most UE4 titles ship `.pak` files
    with no `global.*` at all. Don't assume this marker for UE4.

  If there's no `global.utoc`, pick any other file at an identical relative path on both stores — a
  shipped non-arch-tagged pak, a `Content/` data or config file, a splash/movie asset. The property
  that matters is "same relative path on every store", not this specific filename.

  Pin the path to the **specific project folder** rather than searching for the file: a game can bundle
  extra UE sub-apps with their own `Content/Paks/global.utoc` (halocampaignevolved ships
  `DigitalExtras/HCEDigitalExtrasApp/`), so a loose `find` can match the wrong one.

  **`executable` still needs to be right on Xbox, even though Xbox doesn't launch from it.** It is read
  by `ProcessMonitor` for running-detection and by `getGameVersion`, which silently reports `"0.0.0"`
  when the path doesn't exist — and that feeds collection compatibility gating. (An earlier version of
  this recipe claimed `executable` was "only ever consumed by Steam/default". That was wrong.)

  Declare it per-store — the arms mirror `context.arch` — and add the launcher, which Xbox needs to
  start the game at all:
  ```yaml
  game:
    executable:
      storeBranch:
        xbox: <Project>/Binaries/WinGDK/<Game>.exe
        default: <Project>/Binaries/Win64/<Game>.exe
    xboxLauncher: { appExecName: App<Project>Shipping }   # read it, don't infer it
  ```
  The `default` arm must be the Steam/default path: Vortex caches the no-argument call as the
  Play-button fallback, so it has to be store-independent. Only `storeBranch` is valid here (not
  `osBranch`/`versionBranch`) — Vortex resolves the executable during discovery, when the store is the
  only known fact. Full reference: `gdl/README.md` → Game registration.

  **Only branch when the path actually differs.** A scalar `executable: <Game>.exe` is the normal case
  and covers every Steam-only game plus any multi-store game whose exe sits at the same relative path.

  Note the divergence from `requiredFiles` in a comment so nobody "fixes" them back into lockstep. One
  trade-off to be aware of: a non-exe fingerprint no longer implicitly proves the binaries exist, so a
  corrupted install can pass discovery and then fail to launch.

  **Two layout facts worth knowing before you write paths:**

  - Vortex reports the **`...\Content` folder** as the Xbox game root, so the project folder sits
    directly beneath `${installPath}` exactly as it does on Steam. One `gamePath:
    ${installPath}/<Project>` works for both (verified: subnautica2, halocampaignevolved).
  - Only `<Project>/Binaries` becomes WinGDK. **`Engine/Binaries` stays `Win64`** even on Xbox — don't
    assume "WinGDK everywhere".

  Use `context.arch` for the split, and it resolves everywhere `${arch}` appears:
  ```yaml
  context:
    arch: { storeBranch: { xbox: WinGDK, default: Win64 } }
  ```

  **Disclose what Xbox support won't fix.** Root-shaped mods that hardcode
  `<Project>/Binaries/Win64/` *inside the archive* deploy verbatim, so on Game Pass they land in a
  folder the game never loads and silently do nothing. Not fixable from the extension — the arch is
  baked into the mod's own paths. Note it in `game.yaml` rather than implying full parity.

Steam is usually enough to ship; add epic/xbox when the ids are confirmed. A wrong/guessed epic or
xbox id degrades gracefully (that store just won't auto-detect) — never invent one; omit instead.
But omit only for want of a **confirmed id** — a WinGDK layout is no longer a reason to skip Xbox
(see above).

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
| UE5, unreleased with **nothing** confirmed | `games/starwarszerocompany` | The extreme case: scaffolded pre-release with no install, no Steam depot/installdir, **zero** Nexus mods and no extension page. Project folder, exe and config leaf are all placeholders. Shows how to mark a whole file `# UNVERIFIED`, document a corpus that can't run at all (the domain doesn't resolve in the v2 API), and label test cases as illustrative rather than real. |
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
