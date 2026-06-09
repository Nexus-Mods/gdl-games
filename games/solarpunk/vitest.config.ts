import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

// The shared GDL toolchain lives at the monorepo root (../../gdl), not beside this
// game. GDL's generated code imports the runtime via a path that assumes a single-game
// layout ('@gdl/runtime' and a relative '../gdl/src/runtime/index.js'), so remap both
// to the real shared runtime source here.
const root = import.meta.dirname;
const runtime = resolve(root, '../../gdl/src/runtime/index.ts');

export default defineConfig({
  test: {
    include: ['.gdl-out/tests.gen.ts'],
    globals: false,
    // A skeleton game (no `tests.cases`) generates no tests.gen.ts; don't fail then.
    passWithNoTests: true,
    alias: [
      { find: '@gdl/runtime', replacement: runtime },
      { find: /^\.\.\/gdl\/src\/runtime\/index\.js$/, replacement: runtime },
    ],
  },
});
