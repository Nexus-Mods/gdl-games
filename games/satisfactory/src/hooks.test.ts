import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  BLUEPRINT_MOD_TYPE,
  BlueprintInstallError,
  blueprintsDir,
  planBlueprintInstall,
} from './hooks';

const copies = (instructions: ReturnType<typeof planBlueprintInstall>) =>
  instructions
    .filter((i): i is { type: 'copy'; source: string; destination: string } => i.type === 'copy')
    .map(i => [i.source, i.destination.split(path.sep).join('/')]);

describe('planBlueprintInstall', () => {
  it('copies each .sbp/.sbpcfg pair into every session, flattened, and tags the mod type', () => {
    const result = planBlueprintInstall(
      ['Pack v2/Factories/Smelter.sbp', 'Pack v2/Factories/Smelter.sbpcfg', 'Pack v2/README.txt', 'Pack v2/'],
      ['Main', 'Creative'],
    );
    expect(copies(result)).toEqual([
      ['Pack v2/Factories/Smelter.sbp', 'Main/Smelter.sbp'],
      ['Pack v2/Factories/Smelter.sbpcfg', 'Main/Smelter.sbpcfg'],
      ['Pack v2/Factories/Smelter.sbp', 'Creative/Smelter.sbp'],
      ['Pack v2/Factories/Smelter.sbpcfg', 'Creative/Smelter.sbpcfg'],
    ]);
    expect(result.at(-1)).toEqual({ type: 'setmodtype', value: BLUEPRINT_MOD_TYPE });
  });

  it('accepts Windows separators and mixed-case extensions', () => {
    const result = planBlueprintInstall(['Pack\\Belt.SBP', 'Pack\\Belt.SbpCfg'], ['S1']);
    expect(copies(result)).toEqual([
      ['Pack\\Belt.SBP', 'S1/Belt.SBP'],
      ['Pack\\Belt.SbpCfg', 'S1/Belt.SbpCfg'],
    ]);
  });

  it('refuses two blueprints with the same file name instead of overwriting one', () => {
    expect(() =>
      planBlueprintInstall(['Small/Hub.sbp', 'Large/hub.SBP'], ['S1']),
    ).toThrow(/two blueprint files named/);
  });

  it('explains what to do when no session folder exists yet', () => {
    expect(() => planBlueprintInstall(['Hub.sbp'], [], 'C:/x/blueprints')).toThrow(
      /No blueprint session folders were found in "C:\/x\/blueprints".*save a blueprint/,
    );
  });

  it('throws a BlueprintInstallError when there is nothing to install', () => {
    expect(() => planBlueprintInstall(['Megaprint.cbp', 'README.txt'], ['S1'])).toThrow(
      BlueprintInstallError,
    );
  });
});

describe('blueprintsDir', () => {
  it('resolves under LOCALAPPDATA', () => {
    expect(blueprintsDir({ LOCALAPPDATA: 'C:/Users/u/AppData/Local' })?.split(path.sep).join('/')).toBe(
      'C:/Users/u/AppData/Local/FactoryGame/Saved/SaveGames/blueprints',
    );
  });

  it('is undefined without LOCALAPPDATA', () => {
    expect(blueprintsDir({})).toBeUndefined();
  });
});
