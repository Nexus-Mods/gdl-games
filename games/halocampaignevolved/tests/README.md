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

## Manually verified in Vortex, 2026-07-26

Stronger evidence than the corpus: real mods installed through Vortex against a real Steam install
(`Halo Campaign Evolved`, project folder `Meteorite`), with the deployed paths and symlink targets
checked on disk. All 8 installers that published mods exercise were confirmed.

> **This verified where files landed, not that the game loaded them.** It was run under **symlink**
> deployment, which we now know crashes UE5 IoStore titles at startup — proven on
> `starwarszerocompany` (see `games/starwarszerocompany/tests/README.md` and
> [`docs/deployment-methods.md`](../../../docs/deployment-methods.md)). This game is very likely
> affected the same way and still has `supportsSymlinks: true`, which is a no-op. **Untested**: the
> game is not installed locally. Re-run the pak rows under hardlink before trusting the `pak` and
> `pak-iostore` entries below.

| Installer | modType assigned | Mod(s) | Deployed to — verified |
|---|---|---|---|
| `ue4ss-injector` | `hce-ue4ss-injector` | 9 | `Meteorite/Binaries/Win64/` — `dwmapi.dll` + `ue4ss/` |
| `ue4ss-lua` | `hce-ue4ss` | 14 | `Binaries/Win64/ue4ss/Mods/HCEDebugMenu/` |
| `config-ini` | `hce-config` | 3 | `%LOCALAPPDATA%/Meteorite/Saved/Config/Windows/Engine.ini` |
| `menu-movie` | `hce-menumovie` | 15 | `Content/Movies/MainMenu_Background/` — wrapper folder stripped |
| `pak` | `hce-pak` | 35, 42, 46 | `Content/Paks/~mods/` — flat |
| `pak-iostore` | `hce-pak` | 19 | `Content/Paks/~mods/pakchunk0-WinGDK.utoc` |
| `root` | `hce-root` | 11 | tree intact under `Meteorite/Binaries/Win64/` |

Findings worth keeping:

- **`config-ini` resolves outside the install dir correctly**, and the leaf is `Windows` — an earlier
  guess of `WindowsClient` would have created a directory the game never reads while still looking
  like a successful deploy. `setup.ensureDirs` created `~mods` (absent beforehand).
- **`pak` collapses an archive's own `~mods/` prefix** (mod 46) rather than producing `~mods/~mods/`.
- **`root` beat `native-dll`** on mod 11: the symlink source retains `Meteorite/Binaries/Win64/` and
  the deployment manifest sits at the install root, so the game-relative tree deployed whole instead
  of being flattened into `Binaries`. That priority ordering is the thing most at risk of regressing.
- **`pak-iostore` and `pak` share `modType: hce-pak`** by design (same destination), so Vortex's
  modType label can't distinguish them — only the corpus output names the installer.
- Mod 15 left a `FMS_MainMenuBackground.mp4.vortex_backup` of the shipped 101 MB video, so the
  replacement is reversible.

Not exercised by any published mod, so unit-test coverage only: `reshade`, `native-dll`, `logicmods`,
`pak-alt`, `content-folder`, `ue4ss-lua-enabled`, `ue4ss-lua-bare`.
