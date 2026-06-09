# gdl-games

Monorepo of [Nexus Mods](https://www.nexusmods.com/) **Vortex** game extensions, built from a
single shared [GDL](https://github.com/Nexus-Mods/game-description-language) (Game Description
Language) toolchain.

Each game is just a declarative `game.yaml` (plus a `gameart.webp` logo) under `games/<id>/`.
GDL compiles that into a bundled Vortex extension. There is **one** copy of the GDL toolchain
for the whole repo (the `gdl/` submodule), and **one** set of orchestration / CI / packaging
config at the root — no per-game `package.json`, `vitest.config`, or workflow files.

```
gdl-games/
├── gdl/                      # shared GDL toolchain (git submodule, built once)
├── games/
│   └── solarpunk/            # one folder per game — just two files:
│       ├── game.yaml         #   the game definition (incl. top-level `version:`)
│       └── gameart.webp      #   the logo
├── scripts/run-gdl.mjs       # runs a gdl command against every games/*/game.yaml
├── vitest.config.ts          # one config that tests every game
├── .github/workflows/ci.yml  # build/test all games; release on version bump
└── package.json              # root scripts: build / test / package ALL games
```

## Setup

```sh
git clone --recurse-submodules <repo-url>
cd gdl-games
pnpm init-gdl     # install + build the shared GDL toolchain (run once, or after a gdl bump)
pnpm install      # install root dev deps (vitest)
```

If you already cloned without submodules: `git submodule update --init --recursive`.

## Working with all games at once

```sh
pnpm build        # build every game
pnpm test         # build, then run every game's generated tests (root vitest config)
pnpm package      # package every game into games/<id>/out/<id>-vortex-v<version>.zip
pnpm test:corpus  # run installer rules against cached Nexus manifests (see below)
```

Each of these calls `scripts/run-gdl.mjs`, which discovers every `games/*/game.yaml` and invokes
the shared `gdl` CLI once per game.

## Working with a single game

From inside the game folder, call the shared toolchain directly:

```sh
cd games/solarpunk
node ../../gdl/dist/cli.js build
node ../../gdl/dist/cli.js package
node ../../gdl/dist/cli.js test:corpus --fetch   # needs NEXUS_API_KEY
```

## Corpus testing (local)

`gdl test:corpus --fetch` pulls every published mod's file-listing for the game's `nexusDomain`
from the Nexus API into `games/<id>/tests/cache/` (git-ignored) and runs the installer rules +
`validators` against them. It needs a `NEXUS_API_KEY` env var and is a **local** check — it is not
wired into CI.

## Releasing

Releases are **gated on a version bump** — there are no hand-typed tags. To ship a game:

1. Bump the top-level `version:` in `games/<id>/game.yaml`.
2. Make sure that `game.yaml` has a `nexus:` block with real ids and real store ids
   (no `PLACEHOLDER`/`0`).
3. Merge to `main`.

CI then walks every game, and for each one whose `version` has no matching `<id>-v<version>` git
tag yet, it packages the extension, creates a GitHub release (the tag doubles as the
"already-published" ledger), and uploads to Nexus Mods. Games with an unchanged version are
skipped. A placeholder guard refuses to publish any game whose `game.yaml` still contains stub ids.

## Adding a new game

Create `games/<id>/game.yaml` and drop in a `games/<id>/gameart.webp`. That's it — no
`package.json`, no `vitest.config`, no workflow. The root scripts and CI pick up any
`games/*/game.yaml` automatically.

A minimal `game.yaml`:

```yaml
gdl: 1
version: 0.0.1
game:
  id: <id>
  name: <Human Friendly Name>
  executable: <id>.exe
  requiredFiles: [<id>.exe]
  logo: gameart.webp
  nexusDomain: <id>
stores:
  steam: "<steam app id>"
modTypes: []
installers: []
tests:
  corpus: off
  cases: []
```

`node ../../gdl/dist/cli.js init <id>` can scaffold a starting `game.yaml`, but delete the other
files it emits (`package.json`, `vitest.config`, `.github/`, `.gitignore`) — the root provides
those. Add a `nexus:` block only once the extension's Nexus page exists (GDL rejects `0`/
placeholder nexus ids at build time).
