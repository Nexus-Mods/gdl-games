import * as path from 'path';
import { fs, util } from 'vortex-api';

// Satisfactory 1.0+ reads blueprints per save session, from
// %LOCALAPPDATA%/FactoryGame/Saved/SaveGames/blueprints/<SessionName>/, as a
// <Name>.sbp + <Name>.sbpcfg pair. A GDL install hook gets no Vortex api, so it
// can't ask which session the user wants; instead it installs every blueprint
// into every session folder that exists at install time. Sessions created later
// don't get it until the mod is reinstalled.
//
// The game creates a session's folder only when the first blueprint is saved
// in that session (satisfactory.wiki.gg/wiki/Blueprint, "Save location"), so a
// session with no blueprints of its own is invisible here.

export const BLUEPRINT_MOD_TYPE = 'satisfactory-blueprint';

const BLUEPRINT_FILE = /\.(sbp|sbpcfg)$/i;

type Instruction =
  | { type: 'copy'; source: string; destination: string }
  | { type: 'setmodtype'; value: string };

export class BlueprintInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlueprintInstallError';
  }
}

export function blueprintsDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const local = env.LOCALAPPDATA;
  return local ? path.join(local, 'FactoryGame', 'Saved', 'SaveGames', 'blueprints') : undefined;
}

/**
 * Pure planner: copy every .sbp/.sbpcfg in the archive, flattened to its file
 * name, into each session folder. Destinations are relative to the
 * satisfactory-blueprint mod type path (the blueprints folder).
 */
export function planBlueprintInstall(
  files: readonly string[],
  sessions: readonly string[],
  dir = '%LOCALAPPDATA%/FactoryGame/Saved/SaveGames/blueprints',
): Instruction[] {
  const blueprintFiles = files.filter(f => !/[\\/]$/.test(f) && BLUEPRINT_FILE.test(f));
  if (blueprintFiles.length === 0) {
    throw new BlueprintInstallError('This archive contains no .sbp or .sbpcfg blueprint files.');
  }

  // Blueprints share one flat folder per session, so two archive files with the
  // same name would overwrite each other. Refuse rather than pick one silently.
  const byName = new Map<string, string>();
  for (const file of blueprintFiles) {
    const name = path.basename(file.replace(/\\/g, '/'));
    const key = name.toLowerCase();
    const existing = byName.get(key);
    if (existing !== undefined) {
      throw new BlueprintInstallError(
        `This archive contains two blueprint files named "${name}" ("${existing}" and "${file}"). ` +
          'Satisfactory keeps each session\'s blueprints in one folder, so only one of them can be ' +
          'installed. Install the files you want manually.',
      );
    }
    byName.set(key, file);
  }

  if (sessions.length === 0) {
    throw new BlueprintInstallError(
      `No blueprint session folders were found in "${dir}". Satisfactory creates a session's ` +
        'folder the first time you save a blueprint in that session. Save any blueprint in-game ' +
        'in each session you want these blueprints in, then reinstall this mod.',
    );
  }

  const copies: Instruction[] = [];
  for (const session of sessions) {
    for (const source of byName.values()) {
      copies.push({
        type: 'copy',
        source,
        destination: path.join(session, path.basename(source.replace(/\\/g, '/'))),
      });
    }
  }
  return [...copies, { type: 'setmodtype', value: BLUEPRINT_MOD_TYPE }];
}

export async function listSessionDirs(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdirAsync(dir);
  } catch {
    return [];
  }
  const checked = await Promise.all(
    entries.map(async (entry: string) => {
      try {
        const stat = (await fs.statAsync(path.join(dir, entry))) as { isDirectory: () => boolean };
        return stat.isDirectory() ? entry : null;
      } catch {
        return null;
      }
    }),
  );
  return checked.filter((e): e is string => e !== null).sort();
}

// Vortex reports a SetupError as "Installation failed" with the message and no
// "report bug" button, which suits a problem the user fixes themselves.
function toUserError(err: unknown): Error {
  if (!(err instanceof BlueprintInstallError)) return err as Error;
  const SetupError = (util as unknown as { SetupError?: new (message: string) => Error }).SetupError;
  return SetupError ? new SetupError(err.message) : err;
}

export async function installBlueprints(
  files: string[],
  _destinationPath: string,
  _gameId: string,
): Promise<{ instructions: unknown[] }> {
  const dir = blueprintsDir();
  const sessions = dir !== undefined ? await listSessionDirs(dir) : [];
  try {
    return { instructions: planBlueprintInstall(files, sessions, dir) };
  } catch (err) {
    throw toUserError(err);
  }
}
