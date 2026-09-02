# Manual verification: Star Wars Zero Company

## Symlink deployment crashes the game (2026-08-30)

Why `details.supportsSymlinks: false` is set, and the evidence behind it. Ran against a real Steam
install with game, Vortex staging folder and `%LOCALAPPDATA%` all on C:, so the cross-volume
constraint never applied. Extension 1.0.1 as shipped. Mod: Nexus mod 39 "Classes Unlocked", two
IoStore triplets, routed by the `pak` installer to `swzc-pak`. Indicator: whether "Mandalorian
Warrior" is selectable in the character creator.

| Deployment | Files in `~mods` | In game |
|---|---|---|
| purged | empty | indicator **absent** (control) |
| Hardlink | `HardLink`, real sizes (347 / 19942 / 868 …) | indicator **present**, mod works |
| Symlink (elevated) | `SymbolicLink`, **`Length` 0 on every file** | **crash at startup** |

Both deploys were clean (`{"added":6}`, no Vortex errors), so the only variable was the link type.

```
Unhandled Exception: EXCEPTION_ACCESS_VIOLATION reading address 0x000001fc26749000
FMemoryReaderView::Serialize()
FArchive::ByteOrderSerialize<unsigned int>()
FCustomVersionContainer::Serialize()
FZenPackageHeader::MakeView()
FAsyncPackage2::Event_ProcessPackageSummary()
FAsyncLoadingThread2::Run()
```

`FZenPackageHeader` / `FAsyncPackage2` / `FAsyncLoadingThread2` are the UE5 Zen loader, reached only
by the IoStore path. A legacy `.pak` never gets there. Crashed on the GameThread at
`SecondsSinceStart = 0` during initial package load, with `bIsOOM = 0`, so a bad read rather than a
bad allocation.

A Windows symlink reports the reparse point's own size instead of the target's, which fits the
loader reading outside its buffer. That last step is **not proven**: separating it from "the bytes
read back wrong through the reparse point" needs symbols and the minidump. The `Length` 0 versus
real-size contrast above is the evidence for it.

### Verification of the fix (1.0.2)

- Vortex refuses symlink with its own message, *"Game doesn't support symlinks"*. Dropdown offers
  Hardlink and Move only.
- Migration is automatic: Vortex purges the old symlink deployment **using the old method** and
  switches to hardlink. Users need not purge first. They do see a modal titled **Error** and a UAC
  prompt while it happens.
- Redeployed mod 39 on hardlink: 6 files, real sizes, mod works, no crash.

## Facts confirmed on the real install

- **Engine is UE 5.6.1, Shipping**, from the crash report's
  `EngineVersion 5.6.1-196320+++ProjectBruno+Stable`. The `game.yaml` header previously recorded UE5
  as inferred from press coverage.
- **The game writes no log.** Logging is compiled out of the Shipping build: the executable contains
  no UE log category strings (`LogPakFile`, `LogIoStore`, `LogInit`) and no `Saved/Logs` path string,
  while a control string (`Unreal`) is present. `-log` and `-LogCmds` open a console but produce
  nothing; the only output is Steam's own breakpad init. **Crash dumps under `Saved/Crashes` are the
  only engine-side diagnostic.**
- **`setup.ensureDirs` resolves correctly**: `~mods`, `ue4ss/Mods` and the `%LOCALAPPDATA%` config
  dir were all created on first manage.
- **The install layout matches `game.yaml`**: root `SWZeroCompany.exe`, `SWZeroCompany/`, `Engine/`,
  and `Content/Paks` holding `global.utoc/.ucas` plus `pakchunk0`, `pakchunk0optional` and
  `pakchunk1` triplets.

## Known issue, not yet fixed

On first manage, Vortex evaluated deployment methods **before** `setup()` had created `~mods` and
`ue4ss/Mods`, so hardlink was rejected for those two modTypes and symlink was chosen:

```
10:53:49.259  hardlink deployment not supported due to lack of write access  swzc-pak
10:53:49.280  deploying mods ... method: "Symlink Deployment (Run as Administrator)"
10:53:52.127  setup game mode "starwarszerocompany"        <- 2.8s later, creates both
```

The "lack of write access" text is misleading: hardlink's `fs.accessSync(path, W_OK)` throws
`ENOENT` on a path that does not exist, and Vortex reports that as a permissions problem. It
recovered on the next evaluation and nothing was persisted, but the race is real. See
[`docs/deployment-methods.md`](../../../docs/deployment-methods.md).

## 1.0.3: the cross-volume block, and its fix (2026-08-31)

1.0.2 fixed the crash but introduced a hard block. With **game and staging both on D:** Vortex
offered no deployment method at all and showed "Mods can't be deployed."

`swzc-config` is the only modType off the game drive. Hardlink and move both compare a modType's
target against the STAGING folder, and `getSupportedActivators` requires a method to support every
registered modType, so that one path on C: removed both. 1.0.2 refuses symlink, so nothing remained.
Measured `dev` ids on the real setup:

```
staging  (the game's volume, D: on this machine)    dev=2358103571
swzc-pak / logicmods / binaries / root / ...       dev=2358103571   PASS
swzc-config  %LOCALAPPDATA%\SWZeroCompany\...      dev=1182716225   FAIL
```

No staging location can fix it: it would have to be on D: and C: at once.

`deploymentEssential: false` (game-description-language#9) demotes that rejection to a warning.
Verified on the same setup: Hardlink Deployment offered and selected, mod 39 deployed as six
hardlinks with real sizes.

### What it does not fix

A config mod still cannot deploy for those users:

```
[WARN] failed to link {"link":"Engine.ini",
  "error":"EXDEV: cross-device link not permitted, link
    '<staging>\Engine.ini' -> '%LOCALAPPDATA%\SWZeroCompany\Saved\Config\Windows\Engine.ini'"}
```

`LinkingDeployment.ts:255-268` catches link failures **per file**, so the deployment still runs to
completion and every other mod deploys. Only that mod's files are missing. An earlier reading of the
code predicted the whole deployment would abort; testing disproved that.

The user-facing part is the real problem. Because the error count incremented, Vortex shows:

> **Deployment failed.** 1 files were not correctly deployed (see log for details). The most likely
> reason is that files were locked by external applications so please ensure no other application
> has a mod file open, then repeat deployment.

That diagnosis is wrong for a cross-volume link, and nothing the user does to applications will fix
it. Release notes must say so. A `diagnostics:` health check stating the real reason would be the
better answer.

### Reproducing

Game and staging on a non-system volume, then Settings -> Mods. Note the deployment-method reasons
are **not** logged: `IUnavailableReason.description` is a lazy function rendered only into the
dialog, so a log alone cannot explain a "can't be deployed" report. Ask for the dialog too.
