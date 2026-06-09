import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['.gdl-out/tests.gen.ts'],
    globals: false,
    // A skeleton game (no `tests.cases` in game.yaml) generates no tests.gen.ts;
    // don't fail the suite until real cases exist.
    passWithNoTests: true,
  },
});
