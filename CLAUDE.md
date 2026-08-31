# CLAUDE.md

Monorepo of Vortex game extensions. Each game is one declarative `games/<id>/game.yaml` (plus a
`gameart.webp`, and `src/hooks.ts` only if it references a hook), compiled by the shared `gdl/`
toolchain. Nx infers a project per `game.yaml` — there are no per-game `package.json`,
`vitest.config`, or workflow files.

This file defines nothing on its own. It says where each fact lives, and lists the rules that apply
to every session.

## Where things are documented

| Looking for | Read |
|---|---|
| `game.yaml` DSL: keys, predicates, `take`/`anchor`/`placeAt`, built-in facts, CLI flags | [`gdl/README.md`](gdl/README.md) |
| Setup, Nx targets, releasing | [`README.md`](README.md) |
| Corpus verification: how it works, how it fails silently, the manifest outage, the workaround | [`docs/corpus-manifests.md`](docs/corpus-manifests.md) |
| What breaks for existing users when you edit a **published** game.yaml | [`docs/published-extension-stability.md`](docs/published-extension-stability.md) |
| Deployment methods: `supportsSymlinks`, why UE5 IoStore games must refuse symlinks, how a modType path removes a method | [`docs/deployment-methods.md`](docs/deployment-methods.md) |
| Authoring a **new** game end-to-end | the `implement-game-extension` skill |
| Research recipes (store ids, artwork URLs) + which game to copy | `.claude/skills/implement-game-extension/references/research-recipes.md` |
| Why a specific game does what it does | that game's `game.yaml` comments |

Don't duplicate a fact across these — add a one-line link instead.

## Rules

1. **Never commit, push, tag, or bump a `version:`** unless asked. A version bump merged to `main`
   makes CI package and **publish to Nexus Mods**. Authoring work ends with a green build and a
   report, not a release.
2. **Never print the value of `NEXUS_API_KEY`.** Length or the authenticated account name is fine.
3. **`gdl/` is a separate repository** (a submodule → `Nexus-Mods/game-description-language`). Don't
   change it while working on a game; propose it as its own PR.
4. **A green `test-corpus` proves nothing on its own.** An all-failed fetch and an empty cache both
   exit 0. Reconcile the `T total` in the summary against the game's real `mods` count before
   claiming coverage — see [`docs/corpus-manifests.md`](docs/corpus-manifests.md).
5. **Don't invent ids or paths.** Omit a store, mark the line `# unverified`, or ask. A wrong path
   usually still builds and tests green, so guesses are expensive to find later.
6. **Never rename or remove a `modType` id on a published game.** Vortex stores the id against every
   installed mod, so renaming it orphans them — and the build, tests and corpus all still pass.
   Changing an installer is milder but means users must reinstall a mod to get the new routing. See
   [`docs/published-extension-stability.md`](docs/published-extension-stability.md) before editing a
   `game.yaml` that has already shipped.
7. **Document per-game research as `#` comments in `game.yaml`** (exemplars:
   `games/solarpunk/game.yaml`, `games/halocampaignevolved/game.yaml`). No per-game README files.
8. Run Nx via **`pnpm nx …`** — it's a local dependency. The Nx target is `test-corpus` (hyphen);
   the underlying gdl CLI subcommand is `test:corpus` (colon).

## Keeping docs honest

`node tools/audit-docs.mjs` checks that every game appears in the template map, that no doc
hardcodes an absolute path, and that relative links resolve. Run it after adding a game or editing
these docs.

It deliberately does **not** check that each `game.yaml` has a header comment block. New games get
one (rule 6 above), but enforcing it across every existing game would turn a documentation habit
into a compliance chore.
