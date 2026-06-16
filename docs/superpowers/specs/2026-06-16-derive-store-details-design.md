# Derive Vortex `game.details` store ids from `stores:`

**Date:** 2026-06-16
**Status:** Approved (design)
**Repos:** `gdl` (submodule — feature) + `gdl-games` (yaml cleanup)

## Problem

Every game extension declares its store ids twice. For example, `subnautica2/game.yaml`:

```yaml
game:
  details:
    steamAppId: 1962700          # duplicate
    epicAppId: "22bf...eb32"     # duplicate
stores:
  steam: "1962700"
  epic: "22bf...eb32"
  xbox: "UnknownWorldsEntertainmen.Subnautica2"
```

The same id appears in `stores:` and again in `game.details`. The two copies feed
two different consumers and GDL never connected them:

1. **`stores.<id>`** → GDL's own discovery. At runtime `discover()` collects every
   `stores[].value` into an `appIds` array and calls
   `util.GameStoreHelper.findByAppId(appIds)` (`gdl/src/runtime/vortex-shim.ts`).
2. **`game.details.<key>`** → a raw passthrough. `registerGame` builds
   `details: { nexusPageId, ...decl.details }` and hands it to Vortex's
   `IGame.details`. Vortex core reads `details.steamAppId` directly.

Authors must keep the two in sync by hand.

## How Vortex consumes `details` (verified against `C:/oss/Vortex`)

- `GameModeManager.ts:434-464` (`storeGame`) — copies `game.details` into the
  persisted `IGameStored.details`. It auto-fills `details.steamAppId` (line 443)
  **only** from `game.queryArgs.steam` (`extractSteamId`, line 466). GDL discovers
  via `queryPath`/`findByAppId` and never sets `queryArgs`, so this auto-fill never
  fires for GDL games — confirming GDL must supply `steamAppId` itself.
- `util/Steam.ts:95-108` — reads `appInfo.steamAppId` to launch via Steam.
- `extensions/gameinfo-steam/src/index.ts:24-46` — reads `game.details['steamAppId']`
  to render the Steam game-info panel.
- `gogAppId` / `epicAppId` are *written* by `game-morrowind` and
  `game-kingdomcome-deliverance` but **no Vortex code reads them**. They are inert
  metadata. We still project them (and the other store ids) per the "in case we
  need them" intent — harmless, since Vortex copies all of `details` through to
  `IGameStored` untouched.

## Design

Make `stores:` the single source of truth. GDL projects every store id into
`game.details` under a conventional key at registration time, so authors write each
id once (in `stores:`).

**Layer:** runtime shim — `registerGame` in `gdl/src/runtime/vortex-shim.ts`.
The shim already receives both the `stores: StoreDecl[]` array and `decl.details`,
so deriving there is DRY and requires no codegen change; every generated extension
picks it up on a rebuild.

```ts
details: {
  ...(decl.nexusDomain !== undefined && { nexusPageId: decl.nexusDomain }),
  ...deriveStoreDetails(stores),   // NEW — one key per store id
  ...decl.details,                 // explicit details still override
},
```

### `deriveStoreDetails(stores)`

For every store entry, emit a `details` key named `<storeId>AppId`:

| store id          | details key            | value                              |
|-------------------|------------------------|------------------------------------|
| `steam`           | `steamAppId`           | number (consumed by Vortex)        |
| `gog`             | `gogAppId`             | number                             |
| `epic`            | `epicAppId`            | string                             |
| `xbox`            | `xboxAppId`            | string (package Identity Name)     |
| `ea`              | `eaAppId`              | string                             |
| `microsoftStore`  | `microsoftStoreAppId`  | string                             |
| `manual`          | — (skipped)            | not a store id                     |

**Value coercion:** if the store value matches `/^\d+$/` → `Number()`, else keep the
string. This yields `steamAppId`/`gogAppId` as numbers (matching the existing
`steamAppId: number` convention and what `Steam.ts` / `gameinfo-steam` expect) and
leaves epic GUIDs / xbox identity names as strings.

**Conflict policy:** `...decl.details` is spread last, so an explicit
`game.details.<key>` always overrides the derived value — nothing breaks if a yaml
keeps one.

### Out of scope (YAGNI)

- No validator warning for redundant `details`/`stores` duplicates. The override
  policy makes leftover dups harmless.
- No codegen (`emit.ts`) change — derivation lives in the runtime shim only.

## yaml cleanup (`gdl-games`)

Delete the now-redundant lines from `game.details`:

- `subnautica2` — `steamAppId`, `epicAppId`
- `solarpunk` — `steamAppId`, `epicAppId`
- `gothic1remake` — `steamAppId`
- `outward2` — `steamAppId`
- `assassinscreedblackflagresynced` — `steamAppId`

`paralives` and `007firstlight` carry only `stores.steam` (no `details` dup) — untouched.

## Testing

- `gdl/tests/vortex-shim.test.ts`:
  - Register with `stores: [steam, epic, xbox]`; assert `details.steamAppId` is a
    number, `details.epicAppId` is a string, `details.xboxAppId` is a string.
  - Assert an explicit `decl.details.steamAppId` overrides the derived value.
- Re-run the full GDL suite (`npm test` in `gdl/`).
- Re-run the `gdl-games` corpus + build to green after the yaml cleanup and
  submodule bump.

## Rollout

1. Implement `deriveStoreDetails` + tests in the `gdl` submodule
   (branch `feat/derive-store-details`).
2. Bump the `gdl` submodule ref in `gdl-games`.
3. Strip the redundant `details` lines from the five yamls.
4. Run tests/build; commit on `gdl-games` branch `feat/derive-store-details`.
