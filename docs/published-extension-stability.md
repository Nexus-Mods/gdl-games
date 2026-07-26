# Changing a published extension: what breaks for existing users

Once a game extension has been released, parts of `game.yaml` become a **contract with every user's
Vortex state**. Vortex records, per installed mod, which `modType` it was assigned and where its
files were deployed. Editing those declarations afterwards doesn't migrate anything.

This is easy to miss because **nothing in this repo catches it**: the build passes, the tests pass,
the corpus passes. The breakage only appears on a user's machine, after the release.

Read this before editing a `game.yaml` whose game has a `nexus:` block and a shipped version.

## What is safe, and what isn't

| Change | Effect on existing users |
|---|---|
| **Add** a new modType | Safe. Nothing references it yet. |
| **Add** a new installer | Safe for installed mods (they keep their current layout), but see *installers* below — they won't benefit until reinstalled. |
| **Rename** a modType id | **Breaks.** Deployed mods still carry the old id, which is no longer registered. |
| **Remove** a modType | **Breaks.** Same as a rename, with nothing to land on. |
| Change a modType's **`path`** | **Partially breaks.** New deployments use the new path; files already deployed stay where they were, with no record that they moved. |
| Change a modType's **`name`** | Safe — display text only. |
| Change an **installer** (`when`/`unless`/`take`/`placeAt`/priority) | Existing mods are unaffected until the user **reinstalls** them. |
| Change a `context:` variable used by a modType `path` | Same as changing the path. |

### Why: the mechanism

`gdl/src/runtime/vortex-shim.ts` registers each modType at extension load:

```ts
this.api.registerModType(mt.id, 50, (gameId) => gameId === decl.id,
  () => this.resolveModTypePath(mt, ctx), async () => true, { name: mt.name });
```

- The **id is the registry key**, stored against each installed mod. Rename or remove it and the
  stored value resolves to nothing registered.
- The **path is a callback**, re-evaluated per deploy — which is why a path change affects future
  deployments but leaves already-deployed files behind.
- **Installers run only at install time.** Changing routing logic cannot retroactively move files;
  the mod must be reinstalled for new rules to apply.

## Rules for iterating on a published game

1. **Treat modType ids as permanent.** Pick carefully the first time — they are effectively public
   API. Prefer a clear, game-prefixed id you won't want to change.
2. **Never rename or delete a published modType id.** If a name is wrong, change the `name:` (display
   text) and leave the `id` alone. If a modType is genuinely obsolete, keep it registered so existing
   mods still resolve, and stop routing new installs to it.
3. **Adding is the safe direction.** New installers and new modTypes don't disturb installed mods.
4. **When a routing fix changes where new installs land, say so in the release notes** — users must
   reinstall affected mods to pick it up. Vortex won't prompt them.
5. **Check before editing:** does this game have a `nexus:` block and a version that's been released?
   `git tag -l "<id>-v*"` shows what has shipped. If nothing has, ids are still free.

## Where this bites in practice

- A **cosmetic id cleanup** (e.g. `<gamename>-pak` → `<abbrev>-pak`) is a breaking change for users,
  despite looking like a no-op in review.
- **Consolidating several games onto shared conventions** — exactly what a per-engine refactor
  tempts you into — would rename ids across published games. Do it for *unreleased* games only, or
  accept the breakage knowingly.
- **Adding a better-targeted installer** (e.g. splitting config files out of a catch-all) improves
  new installs but silently leaves existing ones on the old path. That's usually acceptable; it
  should still be stated.

## Release-time failures the build can't catch

Some `game.yaml` fields are **release metadata read by CI**, not compiled into the bundle — so
`build`, `test` and `test-corpus` all pass regardless of their value, and a bad one only fails
during publish, *after* the ledger tag has been created.

- **`nexus.displayName` must match `^[a-zA-Z0-9 _'().-]+$`.** The Nexus mod-file-version endpoint
  422s otherwise. Halo shipped `"Halo: Campaign Evolved Support for Vortex"`; the colon failed the
  publish while the upload itself had already succeeded. `tools/audit-docs.mjs` now checks this.
- **The tag is created before the publish succeeds.** `ci.yml` creates the GitHub release and
  `<id>-v<version>` tag *then* uploads to Nexus. A publish failure therefore leaves the version
  permanently marked as shipped, and re-running CI does nothing. **Recovery requires a version
  bump**, not a retry — which also means a failed publish burns a version number.

If you add a new field that CI reads at release time, consider whether it needs a guard here too.

## Unknowns worth resolving

The precise user-facing symptom of an orphaned modType — silent fallback, an error, a mod that can't
be deployed or purged — has **not** been verified here; it's inferred from the registration code
above. If you get the chance, test it deliberately on a throwaway profile and record the result,
because it determines how severe rule 2 really is.
