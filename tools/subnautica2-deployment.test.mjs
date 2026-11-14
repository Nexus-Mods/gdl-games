import { describe, it, expect } from 'vitest';
import { createFakeContext } from '@gdl/runtime/testing';
import main from '../games/subnautica2/.gdl-out/extension.ts';

describe('Subnautica 2 IoStore deployment compatibility', () => {
  for (const store of ['steam', 'epic', 'xbox']) {
    it(`refuses file symlinks after ${store} registration and setup`, async () => {
      const h = createFakeContext();
      main(h.context);
      await h.runOnce();
      await h.registered.game.setup({ path: '/games/subnautica2', store });
      // Both built-in Vortex symlink activators inspect this exact IGame field.
      expect(h.registered.game.details.supportsSymlinks).toBe(false);
    });
  }

  it('keeps native buildable containers, Lua and tags together in a root package', async () => {
    const files = [
      'Subnautica2/Mods/TestClock/TestClock.uplugin',
      'Subnautica2/Mods/TestClock/Content/Paks/Windows/TestClock-Windows.pak',
      'Subnautica2/Mods/TestClock/Content/Paks/Windows/TestClock-Windows.utoc',
      'Subnautica2/Mods/TestClock/Content/Paks/Windows/TestClock-Windows.ucas',
      'Subnautica2/Binaries/Win64/ue4ss/Mods/TestClock/Scripts/main.lua',
      'Subnautica2/Binaries/Win64/ue4ss/Mods/TestClock/enabled.txt',
      'Subnautica2/Config/Tags/TestClockTags.ini',
    ];
    const h = createFakeContext();
    main(h.context);
    await h.runOnce();
    await h.registered.game.setup({ path: '/games/subnautica2', store: 'steam' });
    const { result } = await h.runInstaller(files, 'subnautica2');
    expect(result.instructions).toContainEqual({ type: 'setmodtype', value: 'subnautica2-root' });
    const copies = result.instructions.filter(i => i.type === 'copy');
    expect(copies).toHaveLength(files.length);
    for (const file of files) {
      expect(copies).toContainEqual({ type: 'copy', source: file, destination: file });
    }
  });
});
