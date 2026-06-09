# gdl-games

Monorepo of [Nexus Mods](https://www.nexusmods.com/) **Vortex** game extensions, built from a
single shared [GDL](https://github.com/Nexus-Mods/game-description-language) (Game Description
Language) toolchain.

Each game is a small declarative `game.yaml` under `games/<id>/`. GDL compiles that into a
bundled Vortex extension. There is **one** copy of the GDL toolchain for the whole repo (the
`gdl/` submodule), and **one** set of CI / packaging config — no per-game duplication.

```
gdl-games/
├── gdl/                     # shared GDL toolchain (git submodule, built once)
├── games/
│   └── solarpunk/           # one folder per game
│       ├── game.yaml        # the game definition (the only required file)
│       ├── package.json     # version + build/test/package scripts
│       └── vitest.config.ts
├── .github/workflows/ci.yml # build/test all games; release on version bump
├── pnpm-workspace.yaml
└── package.json             # bulk scripts: build / test / package ALL games
```

## Setup

```sh
git clone --recurse-submodules <repo-url>
cd gdl-games
pnpm init-gdl     # install + build the shared GDL toolchain (run once, or after a gdl bump)
pnpm install      # install workspace deps for all games
```

If you already cloned without submodules: `git submodule update --init --recursive`.

## Working with all games at once

These commands fan out across every game in `games/*`:

```sh
pnpm build        # build every game
pnpm test         # test every game
pnpm package      # package every game into games/<id>/out/<id>-vortex-v<version>.zip
```

## Working with a single game

```sh
pnpm --filter game-solarpunk build
pnpm --filter game-solarpunk test
```

Or from inside the game folder, calling the shared toolchain directly:

```sh
cd games/solarpunk
node ../../gdl/dist/cli.js build
node ../../gdl/dist/cli.js package
```

## Releasing

Releases are **gated on a version bump** — there are no hand-typed tags. To ship a game:

1. Bump `version` in `games/<id>/package.json`.
2. Make sure the game's `game.yaml` has real `nexus` ids and store ids (no `PLACEHOLDER`/`0`).
3. Merge to `main`.

CI then walks every game, and for each one whose `version` has no matching `<id>-v<version>` git
tag yet, it packages the extension, creates a GitHub release (the tag doubles as the
"already-published" ledger), and uploads to Nexus Mods. Games with an unchanged version are
skipped. A placeholder guard refuses to publish any game whose `game.yaml` still contains stub ids.

## Adding a new game

```sh
mkdir -p games/<id> && cd games/<id>
node ../../gdl/dist/cli.js init <id> -n "Human Friendly Name"
```

Then adapt the generated `package.json` so its scripts call `../../gdl/dist/cli.js` (not
`gdl/dist/cli.js`), delete the generated `.gitignore` / `.github/` (the repo root provides those),
add a minimal `vitest.config.ts`, and fill in `game.yaml`. Add `<id>` to the CI build matrix.
