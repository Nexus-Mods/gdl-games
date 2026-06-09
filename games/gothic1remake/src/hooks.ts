import { fs, selectors, types } from 'vortex-api';

const GAME_ID = 'gothic1remake';

interface VortexDiscovery {
  path?: string;
  store?: string;
}

function getDiscovery(api: types.IExtensionApi): VortexDiscovery | undefined {
  return (
    selectors.discoveryByGame as unknown as (s: unknown, g: string) => VortexDiscovery | undefined
  )(api.getState(), GAME_ID);
}

function getActiveGameId(api: types.IExtensionApi): string | undefined {
  return (selectors.activeGameId as unknown as (s: unknown) => string | undefined)(api.getState());
}

function resolveUE4SSModsDir(api: types.IExtensionApi): string | undefined {
  const d = getDiscovery(api);
  if (!d?.path) return undefined;
  return `${d.path}/G1R/Binaries/Win64/ue4ss/Mods`;
}

export async function listModDirs(modsDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdirAsync(modsDir);
  } catch {
    return [];
  }
  const candidates = entries.filter((e: string) => e !== 'mods.txt' && e !== 'mods.json');
  const checked = await Promise.all(
    candidates.map(async (entry: string) => {
      try {
        const stat = (await fs.statAsync(`${modsDir}/${entry}`)) as { isDirectory: () => boolean };
        return stat.isDirectory() ? entry : null;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((e): e is string => e !== null);
}

export async function regenerateModsTxt(ctx: {
  profileId: string;
  deployment: unknown;
  api: unknown;
}): Promise<void> {
  const api = ctx.api as types.IExtensionApi;
  if (getActiveGameId(api) !== GAME_ID) return;
  const modsDir = resolveUE4SSModsDir(api);
  if (modsDir === undefined) return;
  const dirs = await listModDirs(modsDir);
  const content = dirs.map((d) => `${d} : 1`).join('\n') + (dirs.length > 0 ? '\n' : '');
  await fs.writeFileAsync(`${modsDir}/mods.txt`, content);
}
