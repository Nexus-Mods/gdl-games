import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// One root config tests every game. GDL's generated test file imports its runtime
// via a single-game-layout path ('@gdl/runtime' and a relative
// '../gdl/src/runtime/index.js'); both are remapped to the shared submodule runtime.
// (Aliases match on the import specifier, so they work for any game depth.)
const runtime = resolve(import.meta.dirname, 'gdl/src/runtime/index.ts');

export default defineConfig({
  test: {
    include: ['games/*/.gdl-out/tests.gen.ts'],
    // A skeleton game (no `tests.cases`) generates no tests.gen.ts; don't fail then.
    passWithNoTests: true,
    alias: [
      { find: '@gdl/runtime', replacement: runtime },
      { find: /^\.\.\/gdl\/src\/runtime\/index\.js$/, replacement: runtime },
    ],
  },
});
