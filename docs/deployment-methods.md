# Deployment methods: what a game.yaml controls, and what silently breaks

Vortex deploys mods by hardlink, symlink or move. Which methods it offers is decided partly by
`game.details` and partly by every `modType` path the extension registers. Get it wrong and the
build, the unit tests, the corpus and `audit-docs` all still pass. The failure appears on a user's
machine, sometimes as a crash.

This page is Vortex-side behaviour, verified against the Vortex source and a real install. None of
it is derivable from anything in this repo.

## The methods

| id | Name | Priority | Game can refuse it? |
|---|---|---|---|
| `hardlink_activator` | Hardlink Deployment | 5 | no |
| `symlink_activator` | Symlink Deployment | 10 | yes |
| `symlink_activator_elevated` | Symlink Deployment (Run as Administrator) | 20 | yes |
| `move_activator` | Move deployment (Experimental!) | 50 | yes |

Lower priority wins when Vortex picks a default. The chosen method is stored at
`state.settings.mods.activator[<gameId>]`. Note the elevated symlink extension lives in a directory
named `symlink_activator_elevate` but its id ends `_elevated`.

## `supportsSymlinks` is a one-way switch

Vortex only ever tests for `false`:

```ts
// symlink_activator/index.ts, and identically in symlink_activator_elevate
if (game.details?.supportsSymlinks === false || game.compatible?.symlinks === false) {
  return { description: t => t("Game doesn't support symlinks") };
}
```

So **`supportsSymlinks: true` does nothing.** It enables nothing, guarantees nothing, and is not a
record that symlinks were tested. It is a comment that looks like configuration, and it reached eight
game.yaml files here by copy-paste before anyone checked.

Write `false` when you mean it. Otherwise omit the key.

`move_activator` has the same shape with `details.supportsMoveActivator` / `compatible.moveActivator`.
Hardlink has no game-level opt-out at all.

`game.compatible: { symlinks: false }` is the modern spelling and is what `IGame` documents, but GDL
cannot emit it and Vortex checks both with an `||`, so `details.supportsSymlinks: false` is the form
to use.

## UE5 IoStore games must set `supportsSymlinks: false`

If `Content/Paks` contains `.utoc`/`.ucas`, the game uses IoStore and **symlinked pak files crash
it**. Confirmed on Star Wars Zero Company (UE 5.6.1 Shipping) on 2026-08-30 with a controlled A/B:
same mod, same destination, same routing, only the link type varied.

| Deployment | Files on disk | Result |
|---|---|---|
| Hardlink | `HardLink`, real sizes | mod works |
| Symlink | `SymbolicLink`, **`Length` 0 on every file** | access violation at startup |

```
Unhandled Exception: EXCEPTION_ACCESS_VIOLATION
FMemoryReaderView::Serialize()
FCustomVersionContainer::Serialize()
FZenPackageHeader::MakeView()
FAsyncPackage2::Event_ProcessPackageSummary()
FAsyncLoadingThread2::Run()
```

Those frames are the UE5 Zen loader, which only the IoStore path reaches; a legacy `.pak` never gets
there. A Windows symlink reports the reparse point's own size rather than the target's, which fits
the loader reading outside its buffer. Separating that from "the bytes read back wrong through the
reparse point" would need symbols, so treat the exact final step as unproven.

The wider Vortex extension ecosystem reached the same rule empirically and without a published cause
(Nexus-Mods/game-oblivionremastered sets `supportsSymlinks: false`; ChemBoy1's ~200 extensions use a
literal `if (IO_STORE) SYM_LINKS = false`).

## One bad modType removes a method for the whole game

`getSupportedActivators` requires a method to support **every registered modType with a non-empty
path**, not just the ones that currently hold mods:

```ts
const modPaths = game.getModPaths(discovery.path);
const modTypes = Object.keys(modPaths).filter(typeId => truthy(modPaths[typeId]));
return activators.filter(act => allTypesSupported(act, state, gameId, modTypes).errors.length === 0);
```

Two consequences that bite in practice.

**Volume.** Hardlink and move both reject a modType whose target is on a different volume from the
**mod staging folder** (not the game):

```ts
if (fs.statSync(installationPath).dev !== fs.statSync(modPaths[typeId]).dev) { ... }
```

A config modType pointing at `${appDataLocal}` therefore removes hardlink and move for the entire
game for any user whose staging folder is not on C:, leaving symlink as the only option. Vortex's
escape hatch is `deploymentEssential: false` on that modType, which demotes the rejection from an
error to a warning. **GDL cannot currently emit it** — `vortex-shim.ts` passes only `{ name }` to
`registerModType` — so this needs a gdl change before a game can rely on it.

**Existence.** Hardlink checks `fs.accessSync(path, W_OK)` before the volume check, and a path that
does not exist yet throws `ENOENT`, which Vortex reports as:

```
hardlink deployment not supported due to lack of write access {"typeId": ..., "path": ...}
```

That message is about a missing directory as often as a permissions problem. Don't go looking at
ACLs or `Program Files` before checking the path exists.

### The `setup()` ordering race

`setup.ensureDirs` creates the modType targets, but Vortex may evaluate deployment methods *before*
calling `setup()`. Observed on a first manage of Star Wars Zero Company:

```
10:53:49.259  hardlink not supported ... swzc-pak    -> Content/Paks/~mods      (did not exist)
10:53:49.260  hardlink not supported ... swzc-ue4ss  -> Binaries/Win64/ue4ss/Mods  (did not exist)
10:53:49.280  deploying mods ... method: "Symlink Deployment (Run as Administrator)"
10:53:52.127  setup game mode "starwarszerocompany"    <- 2.8s later, creates both
```

Hardlink was dropped for the whole game because two directories did not exist yet, and symlink won.
It recovered on the next evaluation and nothing was persisted, but if `onGameModeActivated` wins that
race instead, the symlink choice is written to `settings.mods.activator` and stays. This is a plausible
route to a user reporting "it only offers symlinks".

## Changing the flag on a published game

Flipping `supportsSymlinks` to `false` migrates existing users by itself. Verified on the real
upgrade path, not assumed:

- Vortex logs `Deployment method no longer supported ... reason: Game doesn't support symlinks`.
- It purges the old symlink deployment **using the old method** (`purgeOldMethod`) so nothing is
  orphaned, then switches to hardlink.
- Users do **not** need to purge first.

They do see a modal titled **Error** and a UAC prompt during the purge. Both are the migration
working, and both look like a failure, so say so in the release note.

## Checklist for a new game

1. Does `Content/Paks` hold `.utoc`/`.ucas`? If yes, set `details.supportsSymlinks: false`.
2. Never write `supportsSymlinks: true`. Omit the key instead.
3. Does any modType target a path outside the game folder (`${appDataLocal}`, `${appDataRoaming}`,
   Documents)? If so, that modType removes hardlink and move for off-C: users, and there is currently
   no way to mark it non-essential from `game.yaml`.
4. Verifying it needs the real app. Nothing in this repo's build, tests, corpus or `audit-docs`
   inspects `details`. See `tools/install-extension.mjs` and `tools/vortex-log.mjs`.

## Source

Paths are relative to a Vortex checkout. On the 2.x tree they sit under `src/renderer/src/`; on 1.x
under `src/`.

- `extensions/symlink_activator/index.ts`, `extensions/symlink_activator_elevate/index.ts`
- `extensions/hardlink_activator/index.ts`, `extensions/move_activator/index.ts`
- `extensions/mod_management/util/deploymentMethods.ts`, `.../allTypesSupported.ts`
- `extensions/mod_management/eventHandlers.ts` (activator switching, `purgeOldMethod`)
- `types/IGame.ts` (`details`, `compatible`), `types/IExtensionContext.ts` (`IModTypeOptions`)
