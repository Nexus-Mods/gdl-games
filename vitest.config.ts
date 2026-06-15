import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// One root config tests every game. GDL emits three generated suites per game,
// ALL of which must run:
//   - tests.gen.ts      installer routing (Steam/default baseline)
//   - templates.gen.ts  per-store template resolution (unbound-var / missing-branch guard)
//   - lifecycle.gen.ts  per-store setup-dir + queryModPath pins + did-deploy wiring
// The lifecycle suite is what catches per-store path bugs (e.g. an Xbox project
// folder nested differently than assumed) — it asserts the resolved paths for
// EVERY store declared in `stores:`. It must be wired in, or those assertions
// never run.
//
// GDL's generated files import the runtime via single-game-layout specifiers
// ('@gdl/runtime', '@gdl/runtime/testing', a relative '../gdl/src/runtime/index.js',
// and the 'vortex-api' mock); all are remapped to the shared submodule. (Aliases
// match on the import specifier, so they work for any game depth.)
const runtime = resolve(import.meta.dirname, 'gdl/src/runtime/index.ts');
const runtimeTesting = resolve(import.meta.dirname, 'gdl/src/runtime/testing/index.ts');
const vortexApiMock = resolve(import.meta.dirname, 'gdl/src/runtime/testing/vortex-api-mock.ts');

export default defineConfig({
  test: {
    // The three real suites only — not installers.gen.ts (a rules export with no tests).
    include: ['games/*/.gdl-out/{tests,templates,lifecycle}.gen.ts'],
    // A skeleton game (no `tests.cases`) generates no tests.gen.ts; don't fail then.
    passWithNoTests: true,
    alias: [
      // Order matters: '@gdl/runtime/testing' must precede '@gdl/runtime' — alias
      // matching is first-match-wins and the shorter specifier would otherwise
      // greedily match the subpath (→ .../index.ts/testing).
      { find: '@gdl/runtime/testing', replacement: runtimeTesting },
      { find: '@gdl/runtime', replacement: runtime },
      { find: /^\.\.\/gdl\/src\/runtime\/index\.js$/, replacement: runtime },
      // lifecycle.gen.ts (and the bundled extension/hooks it drives) import
      // 'vortex-api'; under vitest that resolves to the runtime mock.
      { find: 'vortex-api', replacement: vortexApiMock },
    ],
  },
});
