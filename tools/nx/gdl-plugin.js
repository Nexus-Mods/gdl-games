// Nx inference plugin ("Project Crystal"): every games/<id>/game.yaml becomes an
// Nx project whose build/test/package/test-corpus targets drive the shared gdl CLI.
// No per-game config files are needed — a game stays just game.yaml + gameart.webp.
// Caching, inputs and outputs for these targets live in nx.json `targetDefaults`.
const { dirname, basename } = require('node:path');

exports.createNodesV2 = [
  'games/*/game.yaml',
  async (configFiles) =>
    configFiles.map((configFile) => {
      const root = dirname(configFile); // e.g. "games/solarpunk"
      const name = basename(root); //       e.g. "solarpunk"
      return [
        configFile,
        {
          projects: {
            [root]: {
              name,
              root,
              projectType: 'application',
              targets: {
                // Build/package run the gdl CLI from inside the game folder.
                build: {
                  executor: 'nx:run-commands',
                  options: { command: 'node ../../gdl/dist/cli.js build', cwd: root },
                },
                package: {
                  executor: 'nx:run-commands',
                  options: { command: 'node ../../gdl/dist/cli.js package', cwd: root },
                },
                // Tests run from the workspace root so vitest picks up the root
                // vitest.config.ts (runtime aliases), filtered to this game's
                // .gdl-out folder so ALL generated suites run (tests + templates
                // + lifecycle), not just installer routing.
                test: {
                  executor: 'nx:run-commands',
                  options: { command: `vitest run ${root}/.gdl-out` },
                },
                'test-corpus': {
                  executor: 'nx:run-commands',
                  options: { command: 'node ../../gdl/dist/cli.js test:corpus', cwd: root },
                },
              },
            },
          },
        },
      ];
    }),
];
