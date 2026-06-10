# gdl-games

Monorepo of [Nexus Mods](https://www.nexusmods.com/) **Vortex** game extensions, built from a
single shared [GDL](https://github.com/Nexus-Mods/game-description-language) (Game Description
Language) toolchain.

Each game is just a declarative `game.yaml` (plus a `gameart.webp` logo) under `games/<id>/`.
GDL compiles that into a bundled Vortex extension. There is **one** copy of the GDL toolchain
for the whole repo (the `gdl/` submodule), and **one** set of orchestration / CI / packaging
config at the root — no per-game `package.json`, `vitest.config`, or workflow files.

Task running is handled by [Nx](https://nx.dev): each `games/*/game.yaml` is detected as an Nx
project (via an inference plugin — no per-game config), giving cached, parallel `build`/`test`/
`package` targets and `nx affected`.

```
gdl-games/
├── gdl/                       # shared GDL toolchain (git submodule, built once)
├── games/
│   └── solarpunk/             # one folder per game — just two files:
│       ├── game.yaml          #   the game definition (incl. top-level `version:`)
│       └── gameart.webp       #   the logo
├── tools/nx/gdl-plugin.js     # Nx inference plugin: game.yaml → project + targets
├── nx.json                    # Nx caching inputs/outputs + targetDefaults
├── vitest.config.ts           # one config that tests every game
├── .github/workflows/ci.yml   # build/test (Nx affected) + release on version bump
└── package.json               # root scripts (wrap nx)
```

## Setup

```sh
git clone --recurse-submodules <repo-url>
cd gdl-games
pnpm init-gdl     # install + build the shared GDL toolchain (run once, or after a gdl bump)
pnpm install      # install root dev deps (nx, vitest)
```

If you already cloned without submodules: `git submodule update --init --recursive`.

## Working with all games at once

```sh
pnpm build        # nx run-many -t build    — build every game (cached)
pnpm test         # nx run-many -t test     — build + run every game's generated tests
pnpm package      # nx run-many -t package  — zip games/<id>/out/<id>-vortex-v<version>.zip
pnpm test:corpus  # nx run-many -t test-corpus — installer rules vs cached Nexus manifests
```

Nx caches each target by `game.yaml` + `src/**` + `gameart.webp` + the gdl toolchain commit, so
unchanged games are restored from cache. Use `pnpm affected` to act only on games touched by your
changes, e.g. `pnpm nx affected -t build test`.

## Working with a single game

Nx is a local dependency, so run it via `pnpm` (or `npx nx` / `pnpm exec nx`). Bare `nx ...` only
works if Nx is installed globally.

```sh
pnpm nx run solarpunk:build
pnpm nx run solarpunk:test
pnpm nx run solarpunk:package
pnpm nx run solarpunk:test-corpus              # corpus vs cached manifests
pnpm nx run solarpunk:test-corpus -- --fetch   # fetch fresh from Nexus (needs NEXUS_API_KEY)
```

The Nx target is `test-corpus` (hyphen) because Nx target names can't contain `:` (it separates
`project:target`); the underlying gdl CLI subcommand is still `test:corpus`.

Or from inside the game folder, call the shared toolchain directly (bypassing Nx):

```sh
cd games/solarpunk
node ../../gdl/dist/cli.js build
node ../../gdl/dist/cli.js package
node ../../gdl/dist/cli.js test:corpus --fetch   # needs NEXUS_API_KEY
```

## Corpus testing (local)

Corpus testing pulls every published mod's file-listing for a game's `nexusDomain` from the Nexus
API into `games/<id>/tests/cache/` (git-ignored) and runs the installer rules + `validators`
against them. It needs a `NEXUS_API_KEY` env var and is a **local** check — it is not wired into CI.

```sh
pnpm nx run solarpunk:test-corpus -- --fetch   # one game: fetch fresh, then check
pnpm test:corpus                               # all games: check against cached manifests
```

Or run it raw from inside the game folder: `node ../../gdl/dist/cli.js test:corpus --fetch`.

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

From inside `games/<id>/`, `node ../../gdl/dist/cli.js init <id> -n "Human Friendly Name"`
scaffolds the starting `game.yaml` (root-driven — it emits only `game.yaml`, with a top-level
`version:`). Add a `nexus:` block only once the extension's Nexus page exists (GDL rejects `0`/
placeholder nexus ids at build time).
