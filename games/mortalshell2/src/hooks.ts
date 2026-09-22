/**
 * Mortal Shell II — TypeScript hooks (GDL escape hatches).
 *
 * Archive routing and Steam discovery live in game.yaml. Hooks cover:
 * - UE4SS / Ultra+ / manual ownership assessment + diagnostics
 * - DmgModLoader (DML) awareness (Content/Paks/dml) — never confuse with DirectML
 * - ReShade preset mods: suggest installing ReShade from reshade.me when the
 *   runtime is absent from Binaries/Win64 (presets ship the .ini only)
 * - idempotent mods.txt merge
 *
 * Product backlog: PLAN.md (not shipped in the zip).
 */
import { access, readFile, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { actions, fs, log, selectors, types, util } from 'vortex-api';
import {
  classifyDependency,
  decideDependency,
  detectSelfContainedEvidence,
  notificationSafeLabel,
  stableModIdentity,
  type DependencyDecision,
  type DependencyKind,
} from './dependencies';

export const GAME_ID = 'mortalshell2';

/**
 * Nexus mod ids on mortalshell2 (verified against live packages):
 *   5 = UE4SS runtime (dwmapi + ue4ss/, includes BPModLoaderMod)
 *   4 = DmgModLoader (DML) — preferred for fresh LogicMod resolution;
 *       enabled BPModLoader remains valid satisfaction/coexistence
 * Microsoft DirectML lives at Binaries/Win64/DML — ignore for loader detection.
 */
export const DML_NEXUS_MOD_ID = 4;
export const UE4SS_NEXUS_MOD_ID = 5;
/** Stable official ReShade downloads page — presets do not include the runtime. */
export const RESHADE_SITE = 'https://reshade.me/#download';

const BPMOD_LOADER_DIR = 'BPModLoaderMod';

export type Ue4ssOwnership =
  | 'absent'
  | 'vortex-managed'
  | 'externally-managed'
  | 'ultra-managed';

export type DmlOwnership =
  | 'absent'
  | 'vortex-managed'
  | 'externally-managed';

export type RuntimeHealth = 'healthy' | 'partial' | 'absent';

const VORTEX_UE4SS_MODTYPE = 'mortalshell2-ue4ss-framework';
const VORTEX_DML_MODTYPES = ['mortalshell2-dml-framework', 'mortalshell2-dml-tree'] as const;
const ULTRA_MOD_DIR = 'UltraPlusExtensions';
const ULTRA_PAK_PREFIX = '~ultraplus_';

interface VortexDiscovery {
  path?: string;
  store?: string;
}

export interface Ue4ssRuntimeAssessment extends FrameworkPackageState {
  ownership: Ue4ssOwnership;
  health: RuntimeHealth;
  managedByVortex: boolean;
  hasProxy: boolean;
  hasCoreDll: boolean;
  /** Observational only — an empty Mods directory must not contribute to health. */
  hasModsDir: boolean;
  hasSettings: boolean;
  ultraPlusDetected: boolean;
  message?: string;
  /** Short actionable guidance for missing/partial states. */
  guidance?: string;
}

export interface DmlRuntimeAssessment extends FrameworkPackageState {
  ownership: DmlOwnership;
  health: RuntimeHealth;
  managedByVortex: boolean;
  hasDmlDir: boolean;
  /** Proven core payload of the current DML build (dmgmodloader-dml-2018). */
  hasCorePak: boolean;
  hasCoreUcas: boolean;
  hasCoreUtoc: boolean;
  /** Recognizable dmlcore_P.* supporting payload — partial evidence, not a complete runtime. */
  hasSupportPayload: boolean;
  /** Diagnostic only: misplaced install from the old pak-routing bug (never contributes to health). */
  misplacedInPakMods: boolean;
  /** True when Binaries/Win64/DML exists (Microsoft DirectML — not DmgModLoader). */
  directMlPresent: boolean;
  message?: string;
  guidance?: string;
}

/** BPModLoaderMod — required for LogicMods under UE4SS (not implied by a healthy runtime). */
export interface BpModLoaderAssessment {
  present: boolean;
  /** false when missing, disabled in mods.txt, or no enable signal. */
  enabled: boolean;
  modDir?: string;
  guidance: string;
}

function getDiscovery(api: types.IExtensionApi): VortexDiscovery | undefined {
  return (
    selectors.discoveryByGame as unknown as (
      s: unknown,
      g: string,
    ) => VortexDiscovery | undefined
  )(api.getState(), GAME_ID);
}

function getActiveGameId(api: types.IExtensionApi): string | undefined {
  return (selectors.activeGameId as unknown as (s: unknown) => string | undefined)(
    api.getState(),
  );
}

function win64(discoveryPath: string): string {
  return join(discoveryPath, 'MortalShell2', 'Binaries', 'Win64');
}

function ue4ssRoot(discoveryPath: string): string {
  return join(win64(discoveryPath), 'ue4ss');
}

function ue4ssModsDir(discoveryPath: string): string {
  return join(ue4ssRoot(discoveryPath), 'Mods');
}

/** DmgModLoader lives under Content/Paks/dml — never Binaries/Win64/DML (DirectML). */
function dmgModLoaderDir(discoveryPath: string): string {
  return join(discoveryPath, 'MortalShell2', 'Content', 'Paks', 'dml');
}

function microsoftDirectMlDir(discoveryPath: string): string {
  return join(win64(discoveryPath), 'DML');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function nodeErrorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return undefined;
  }
  return String((err as { code?: unknown }).code);
}

function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

interface ArchiveEntry {
  raw: string;
  path: string;
  segments: string[];
  directory: boolean;
}

type InstallerInstruction =
  | { type: 'copy'; source: string; destination: string }
  | { type: 'setmodtype'; value: string };

type InstallerResult = Promise<{ instructions: InstallerInstruction[] }>;

type DestinationMapper = (
  entry: ArchiveEntry,
) => string | undefined;

type DestinationMapperFactory = (
  entries: readonly ArchiveEntry[],
) => DestinationMapper | undefined;

function normaliseInstallerPath(raw: string): string {
  return norm(raw).replace(/^(?:\.\/)+/, '').replace(/\/{2,}/g, '/');
}

function safeRelativePath(path: string): boolean {
  if (path.length === 0 || path.startsWith('/') || /^[a-z]:/i.test(path)) return false;
  const segments = path.split('/').filter(Boolean);
  return segments.length > 0 && segments.every((segment) => segment !== '.' && segment !== '..');
}

function archiveEntries(files: readonly string[]): ArchiveEntry[] | undefined {
  const paths = files.map(normaliseInstallerPath);
  if (paths.some((path) => !safeRelativePath(path))) return undefined;

  // Some archive APIs expose directories as bare entries ("SaveGames") while
  // others include a trailing slash. Build the descendant set once so both
  // spellings are filtered without quadratic rescans.
  const parentPaths = new Set<string>();
  for (const path of paths) {
    const withoutSlash = path.replace(/\/+$/, '');
    for (let slash = withoutSlash.indexOf('/'); slash !== -1; slash = withoutSlash.indexOf('/', slash + 1)) {
      parentPaths.add(withoutSlash.slice(0, slash).toLowerCase());
    }
  }

  return files.map((raw, index) => {
    const path = paths[index]!;
    const withoutSlash = path.replace(/\/+$/, '');
    return {
      raw,
      path: withoutSlash,
      segments: withoutSlash.split('/').filter(Boolean),
      directory: path.endsWith('/') || parentPaths.has(withoutSlash.toLowerCase()),
    };
  });
}

function prefixPath(prefix: string, relative: string): string {
  return `${prefix}/${relative}`.replace(/\/{2,}/g, '/');
}

function stripLeadingSegments(
  entry: ArchiveEntry,
  rootSegments: readonly string[],
): string | undefined {
  if (rootSegments.length === 0) return entry.path;
  if (entry.segments.length < rootSegments.length) return undefined;
  for (let index = 0; index < rootSegments.length; index++) {
    if (entry.segments[index] !== rootSegments[index]) return undefined;
  }
  return entry.segments.slice(rootSegments.length).join('/');
}

function shallowestEntry(
  entries: readonly ArchiveEntry[],
  predicate: (entry: ArchiveEntry) => boolean,
): ArchiveEntry | undefined {
  return entries.reduce<ArchiveEntry | undefined>((best, entry) => {
    if (!predicate(entry)) return best;
    return best === undefined || entry.segments.length < best.segments.length ? entry : best;
  }, undefined);
}

function createInstallerHook(
  modType: string,
  prepareDestinationMapper: DestinationMapperFactory,
) {
  return async (
    files: string[],
    destinationPath: string,
    gameId: string,
  ): InstallerResult => {
    void destinationPath;
    if (gameId !== GAME_ID) return { instructions: [] };

    const entries = archiveEntries(files);
    if (entries === undefined) return { instructions: [] };
    const destinationFor = prepareDestinationMapper(entries);
    if (destinationFor === undefined) return { instructions: [] };

    const copies: InstallerInstruction[] = [];
    for (const entry of entries) {
      if (entry.directory) continue;
      const destination = destinationFor(entry);
      if (destination === undefined) continue;
      if (!safeRelativePath(destination)) return { instructions: [] };
      copies.push({ type: 'copy', source: entry.raw, destination });
    }

    if (copies.length === 0) return { instructions: [] };
    return {
      instructions: [...copies, { type: 'setmodtype', value: modType }],
    };
  };
}

/** Flat DmgModLoader payload; the deployed mod type root remains Content/Paks. */
export const installDmlFramework = createInstallerHook(
  'mortalshell2-dml-framework',
  (entries) => {
    const anchor = shallowestEntry(
      entries,
      (candidate) =>
        !candidate.directory && candidate.segments.at(-1)?.toLowerCase() === 'dml.pak',
    );
    if (anchor === undefined) return undefined;
    const rootSegments = anchor.segments.slice(0, -1);
    return (entry) => {
      const relative = stripLeadingSegments(entry, rootSegments);
      return relative === undefined ? undefined : prefixPath('dml', relative);
    };
  },
);

/** Mod 20's MortalShell2Mod + shared peers must remain one UE4SS Mods tree. */
export const installUe4ssModShared = createInstallerHook(
  'mortalshell2-ue4ss-mod',
  () => (entry) => prefixPath('ue4ss/Mods', entry.path),
);

/** Archive already contains an ue4ss/Mods segment; discard only its wrapper. */
export const installUe4ssModRooted = createInstallerHook(
  'mortalshell2-ue4ss-tree',
  () => (entry) => {
    const index = entry.segments.findIndex(
      (segment, segmentIndex) =>
        segment.toLowerCase() === 'ue4ss' &&
        entry.segments[segmentIndex + 1]?.toLowerCase() === 'mods',
    );
    if (index === -1) return undefined;
    return entry.segments.slice(index).join('/');
  },
);

/** Archive starts at Mods/ModName; add the missing ue4ss ancestor once. */
export const installUe4ssModModsPrefix = createInstallerHook(
  'mortalshell2-ue4ss-tree',
  () => (entry) => {
    const index = entry.segments.findIndex((segment) => segment.toLowerCase() === 'mods');
    if (index === -1) return undefined;
    return prefixPath('ue4ss', entry.segments.slice(index).join('/'));
  },
);

/** ModName/Scripts payload, optionally under one or more wrapper directories. */
export const installUe4ssModScripts = createInstallerHook(
  'mortalshell2-ue4ss-mod',
  (entries) => {
    const anchor = shallowestEntry(
      entries,
      (candidate) =>
        !candidate.directory &&
        candidate.segments.at(-2)?.toLowerCase() === 'scripts' &&
        candidate.segments.at(-1)?.toLowerCase().endsWith('.lua') === true,
    );
    if (anchor === undefined) return undefined;
    const stripCount = Math.max(0, anchor.segments.length - 3);
    const rootSegments = anchor.segments.slice(0, stripCount);
    return (entry) => {
      const relative = stripLeadingSegments(entry, rootSegments);
      return relative === undefined ? undefined : prefixPath('ue4ss/Mods', relative);
    };
  },
);

/** enabled.txt-only UE4SS mod, with the same wrapper handling as the YAML rule. */
export const installUe4ssModEnabled = createInstallerHook(
  'mortalshell2-ue4ss-mod',
  (entries) => {
    const anchor = shallowestEntry(
      entries,
      (candidate) =>
        !candidate.directory && candidate.segments.at(-1)?.toLowerCase() === 'enabled.txt',
    );
    if (anchor === undefined) return undefined;
    const stripCount = Math.max(0, anchor.segments.length - 2);
    const rootSegments = anchor.segments.slice(0, stripCount);
    return (entry) => {
      const relative = stripLeadingSegments(entry, rootSegments);
      return relative === undefined ? undefined : prefixPath('ue4ss/Mods', relative);
    };
  },
);

/** Exact AutoPickup flat triplet; the YAML predicate owns the narrow signature. */
export const installLogicModsRootTriplet = createInstallerHook(
  'mortalshell2-logicmods',
  () => (entry) => prefixPath('LogicMods', entry.path),
);

/** Exact unsupported save shape; directory entries are deliberately not payloads. */
export const installUnsupportedSave = createInstallerHook(
  'mortalshell2-unsupported',
  () => (entry) => entry.path,
);

function isUe4ssDependentPath(file: string): boolean {
  const f = norm(file);
  // Narrow evidence — do not treat arbitrary .lua as UE4SS.
  if (/\/scripts\/main\.lua$/i.test(f)) return true;
  if (/\/ue4ss\/mods\/[^/]+\/scripts\/.+\.lua$/i.test(f)) return true;
  if (/\/mods\/[^/]+\/scripts\/main\.lua$/i.test(f)) return true;
  if (/\/enabled\.txt$/i.test(f) && /\/(ue4ss\/)?mods\//i.test(f)) return true;
  return false;
}

/** LogicMod payload (needs BPModLoaderMod and/or DML — not bare UE4SS). */
export function isLogicModPath(file: string): boolean {
  const f = norm(file).toLowerCase();
  if (f.includes('/logicmods/')) return true;
  return false;
}

export function bpModLoaderGuidance(a: BpModLoaderAssessment, ultraPlus = false): string {
  if (a.present && a.enabled) {
    return 'BPModLoader is enabled, so your LogicMods can load.';
  }
  if (a.present && !a.enabled) {
    return (
      'BPModLoader is installed but disabled. Enable it in ue4ss/Mods/mods.txt ' +
      '(BPModLoaderMod : 1) or add enabled.txt inside BPModLoaderMod/, then redeploy/restart. ' +
      (ultraPlus
        ? 'Ultra+ manages UE4SS, so enabling this mod does not replace it.'
        : '')
    );
  }
  return (
    'BPModLoader is missing. Install or repair UE4SS from Nexus Mods; it includes BPModLoader. ' +
    (ultraPlus
      ? 'If Ultra+ manages UE4SS, copy BPModLoader into ue4ss/Mods instead of replacing UE4SS.'
      : '')
  );
}

/**
 * Detect BPModLoaderMod. Ultra+ (and slim UE4SS builds) often omit it — LogicMods
 * then land correctly but never run.
 */
export async function assessBpModLoader(
  discoveryPath: string,
): Promise<BpModLoaderAssessment> {
  const modDir = join(ue4ssModsDir(discoveryPath), BPMOD_LOADER_DIR);
  const present =
    (await pathExists(join(modDir, 'Scripts', 'main.lua'))) ||
    (await pathExists(join(modDir, 'scripts', 'main.lua')));

  if (!present) {
    const empty: BpModLoaderAssessment = {
      present: false,
      enabled: false,
      guidance: '',
    };
    empty.guidance = bpModLoaderGuidance(empty);
    return empty;
  }

  const hasEnabledTxt = await pathExists(join(modDir, 'enabled.txt'));
  let modsTxtEnabled: boolean | null = null;
  let modsTxtUnreadable = false;
  try {
    const txt = await readFile(join(ue4ssModsDir(discoveryPath), 'mods.txt'), 'utf8');
    const line = txt.split(/\r?\n/).find((l) => /^BPModLoaderMod\s*:/i.test(l.trim()));
    if (line) {
      const m = line.match(/:\s*(\d+)/);
      modsTxtEnabled = m ? m[1] !== '0' : true;
    }
  } catch (err) {
    // ENOENT is a legitimate "no mods.txt" — other read failures must not be
    // treated as enablement evidence.
    if (nodeErrorCode(err) !== 'ENOENT') {
      modsTxtUnreadable = true;
      log.warn(
        '[mortalshell2] UE4SS Mods/mods.txt is unreadable' +
          ` (${String(nodeErrorCode(err) ?? err)}); assuming BPModLoaderMod is disabled.`,
      );
    }
  }

  let enabled = false;
  if (modsTxtEnabled === false || modsTxtUnreadable) {
    enabled = false;
  } else if (modsTxtEnabled === true || hasEnabledTxt) {
    enabled = true;
  } else {
    // Present but no enable signal — common after manual copy; treat as disabled.
    enabled = false;
  }

  const result: BpModLoaderAssessment = { present: true, enabled, modDir, guidance: '' };
  result.guidance = bpModLoaderGuidance(result);
  return result;
}

export interface FrameworkPackageState {
  packagePresent: boolean;
  packageEnabled: boolean;
}

/**
 * Vortex package provenance for a framework mod type. Presence (an installed
 * record) and active-profile enablement are separate facts: only the profile
 * selected in settings.profiles.activeProfileId — when it belongs to this game —
 * can supply `packageEnabled`. A present-but-disabled package, or one enabled in
 * another MS2 profile, never claims an on-disk runtime.
 */
export function assessFrameworkPackageState(
  api: types.IExtensionApi | undefined,
  modTypes: readonly string[],
): FrameworkPackageState {
  if (!api) {
    return { packagePresent: false, packageEnabled: false };
  }

  try {
    const state = api.getState() as {
      settings?: {
        profiles?: { activeProfileId?: string };
      };
      persistent?: {
        mods?: Record<
          string,
          Record<string, { type?: string; state?: string }>
        >;
        profiles?: Record<
          string,
          {
            gameId?: string;
            modState?: Record<string, { enabled?: boolean }>;
          }
        >;
      };
    };

    const acceptedTypes = new Set(modTypes);
    const modsForGame = state.persistent?.mods?.[GAME_ID] ?? {};
    const matching = Object.entries(modsForGame).filter(
      ([, mod]) =>
        mod?.state !== 'uninstalled'
        && acceptedTypes.has(mod?.type ?? ''),
    );

    const packagePresent = matching.length > 0;
    if (!packagePresent) {
      return { packagePresent: false, packageEnabled: false };
    }

    const activeProfileId = state.settings?.profiles?.activeProfileId;
    const activeProfile = activeProfileId
      ? state.persistent?.profiles?.[activeProfileId]
      : undefined;

    if (activeProfile?.gameId !== GAME_ID) {
      return { packagePresent: true, packageEnabled: false };
    }

    const packageEnabled = matching.some(
      ([modId]) => activeProfile.modState?.[modId]?.enabled === true,
    );

    return { packagePresent: true, packageEnabled };
  } catch {
    return { packagePresent: false, packageEnabled: false };
  }
}

/**
 * Detect Ultra+ using multiple stable signals (not a single fragile filename).
 */
export async function detectUltraPlus(discoveryPath: string): Promise<boolean> {
  const mods = ue4ssModsDir(discoveryPath);
  if (await pathExists(join(mods, ULTRA_MOD_DIR))) return true;

  const pakMods = join(
    discoveryPath,
    'MortalShell2',
    'Content',
    'Paks',
    '~mods',
  );
  try {
    const entries = await readdir(pakMods);
    if (entries.some((e) => e.toLowerCase().startsWith(ULTRA_PAK_PREFIX))) {
      return true;
    }
  } catch {
    // no ~mods
  }

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && (await pathExists(join(localAppData, 'UltraPlusManager')))) {
    return true;
  }
  return false;
}

export function ue4ssGuidance(a: Ue4ssRuntimeAssessment): string {
  if (a.health === 'healthy' && a.ownership === 'ultra-managed') {
    return (
      'Ultra+ Manager manages UE4SS. Use Ultra+ Manager to update or repair it.'
    );
  }
  if (a.health === 'healthy' && a.ownership === 'externally-managed') {
    return (
      'UE4SS was installed outside Vortex. Use the tool that installed it to update or repair it.'
    );
  }
  if (a.health === 'healthy' && a.ownership === 'vortex-managed') {
    return 'UE4SS is installed in Vortex. Update or remove it from Vortex.';
  }
  if (a.ultraPlusDetected || a.ownership === 'ultra-managed') {
    return (
      'UE4SS is missing or incomplete while Ultra+ Manager is installed. Repair or ' +
      'reinstall UE4SS with Ultra+ Manager, then re-enable this mod.'
    );
  }
  if (a.health === 'partial') {
    return (
      'UE4SS is incomplete. It needs dwmapi.dll, ue4ss/UE4SS.dll, and ue4ss/Mods beside ' +
      'the game executable. Repair the existing installation, use Ultra+ Manager if it ' +
      'manages UE4SS, or select Install UE4SS in Vortex.'
    );
  }
  return (
    'This mod needs UE4SS. Select Install UE4SS to download it, then install and enable it ' +
    'in Vortex. Use Ultra+ Manager instead if it manages your UE4SS installation.'
  );
}

/**
 * Assess the on-disk UE4SS runtime from filesystem evidence only. Health is
 * derived strictly from meaningful files (proxy dll + core dll); scaffold
 * directories like an empty Mods/ never contribute. Vortex package presence and
 * active-profile enablement are separate facts and only confer ownership when
 * disk evidence exists; positive Ultra+ evidence always wins ownership.
 */
export async function assessUe4ssRuntime(
  discoveryPath: string,
  api?: types.IExtensionApi,
): Promise<Ue4ssRuntimeAssessment> {
  const w64 = win64(discoveryPath);
  const root = ue4ssRoot(discoveryPath);
  const mods = ue4ssModsDir(discoveryPath);

  const hasProxy = await pathExists(join(w64, 'dwmapi.dll'));
  const hasCoreDll =
    (await pathExists(join(root, 'UE4SS.dll'))) ||
    (await pathExists(join(root, 'ue4ss.dll')));
  const hasSettings = await pathExists(join(root, 'UE4SS-settings.ini'));
  const hasModsDir = await pathExists(mods);
  const ultraPlusDetected = await detectUltraPlus(discoveryPath);

  let health: RuntimeHealth = 'absent';
  if (hasProxy && hasCoreDll) {
    health = 'healthy';
  } else if (hasProxy || hasCoreDll || hasSettings) {
    health = 'partial';
  }

  const packageState = assessFrameworkPackageState(
    api,
    [VORTEX_UE4SS_MODTYPE],
  );

  const managedByVortex =
    health !== 'absent'
    && packageState.packageEnabled
    && !ultraPlusDetected;

  let ownership: Ue4ssOwnership = 'absent';
  if (health === 'absent') {
    ownership = 'absent';
  } else if (ultraPlusDetected) {
    ownership = 'ultra-managed';
  } else if (managedByVortex) {
    ownership = 'vortex-managed';
  } else {
    ownership = 'externally-managed';
  }

  const base: Ue4ssRuntimeAssessment = {
    ownership,
    health,
    managedByVortex,
    ...packageState,
    hasProxy,
    hasCoreDll,
    hasModsDir,
    hasSettings,
    ultraPlusDetected,
  };
  const guidance = ue4ssGuidance(base);
  // Surface message for healthy external/ultra (info) and for problems.
  if (
    health !== 'healthy' ||
    ownership === 'ultra-managed' ||
    ownership === 'externally-managed'
  ) {
    return { ...base, message: guidance, guidance };
  }
  return { ...base, guidance };
}

export function dmlGuidance(a: DmlRuntimeAssessment): string {
  if (a.misplacedInPakMods) {
    return (
      'DML was found under Content/Paks/~mods, but it belongs in Content/Paks/dml/. ' +
      'Reinstall DML in Vortex, or move dml*.pak, dml*.ucas, and dml*.utoc into Content/Paks/dml/.'
    );
  }
  if (a.health === 'healthy' && a.ownership === 'externally-managed') {
    return (
      'DML was installed outside Vortex. Vortex can manage compatible LogicMods but will ' +
      'not replace the DML files.'
    );
  }
  if (a.health === 'healthy' && a.ownership === 'vortex-managed') {
    return 'DML is installed in Vortex. Update or remove it from Vortex.';
  }
  if (a.health === 'partial') {
    return (
      'DML is incomplete under Content/Paks/dml. It needs dml.pak, dml.ucas, and dml.utoc. ' +
      'Repair or reinstall DML from Nexus Mods. MortalShell2/Binaries/Win64/DML is Microsoft DirectML, not DML.'
    );
  }
  return (
    'DML is not installed. Select Install DML to download it, then install and enable it in ' +
    'Vortex. Do not use Binaries/Win64/DML, which is Microsoft DirectML.'
  );
}

/**
 * Assess the on-disk DmgModLoader runtime from filesystem evidence only. Health
 * is signature-based: complete dml.pak/ucas/utoc core triplet = healthy, any
 * recognizable core or dmlcore_P.* support file = partial. Vortex package state
 * never confers health; misplaced ~mods installs and Microsoft DirectML are
 * reported diagnostically without affecting runtime classification.
 */
export async function assessDmlRuntime(
  discoveryPath: string,
  api?: types.IExtensionApi,
): Promise<DmlRuntimeAssessment> {
  const dmlDir = dmgModLoaderDir(discoveryPath);
  const hasDmlDir = await pathExists(dmlDir);
  const directMlPresent = await pathExists(microsoftDirectMlDir(discoveryPath));
  const misplacedInPakMods = await pathExists(
    join(discoveryPath, 'MortalShell2', 'Content', 'Paks', '~mods', 'dml.pak'),
  );

  let entries: string[] = [];
  if (hasDmlDir) {
    try {
      entries = await readdir(dmlDir);
    } catch {
      entries = [];
    }
  }

  const names = new Set(entries.map((entry) => entry.toLowerCase()));
  const hasCorePak = names.has('dml.pak');
  const hasCoreUcas = names.has('dml.ucas');
  const hasCoreUtoc = names.has('dml.utoc');
  const hasSupportPayload = [
    'dmlcore_p.pak',
    'dmlcore_p.ucas',
    'dmlcore_p.utoc',
  ].some((name) => names.has(name));

  const completeCore = hasCorePak && hasCoreUcas && hasCoreUtoc;
  const recognizablePayload =
    hasCorePak || hasCoreUcas || hasCoreUtoc || hasSupportPayload;

  let health: RuntimeHealth = 'absent';
  if (completeCore) {
    health = 'healthy';
  } else if (recognizablePayload) {
    health = 'partial';
  }

  const packageState = assessFrameworkPackageState(
    api,
    VORTEX_DML_MODTYPES,
  );

  const managedByVortex =
    health !== 'absent' && packageState.packageEnabled;

  let ownership: DmlOwnership = 'absent';
  if (health === 'absent') {
    ownership = 'absent';
  } else if (managedByVortex) {
    ownership = 'vortex-managed';
  } else {
    ownership = 'externally-managed';
  }

  const base: DmlRuntimeAssessment = {
    ownership,
    health,
    managedByVortex,
    ...packageState,
    hasDmlDir,
    hasCorePak,
    hasCoreUcas,
    hasCoreUtoc,
    hasSupportPayload,
    misplacedInPakMods,
    directMlPresent,
  };
  const guidance = dmlGuidance(base);
  if (health !== 'healthy' || ownership === 'externally-managed') {
    return { ...base, message: guidance, guidance };
  }
  return { ...base, guidance };
}

export async function detectGameVersion(ctx: {
  installPath: string;
}): Promise<string | null> {
  try {
    const exe = join(
      ctx.installPath,
      'MortalShell2',
      'Binaries',
      'Win64',
      'MortalShell2-Win64-Shipping.exe',
    );
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const ps =
      `(Get-Item -LiteralPath '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`;
    const { stdout } = await execFileAsync(
      'powershell.exe',
      ['-NoProfile', '-Command', ps],
      { windowsHide: true },
    );
    const v = stdout.trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

type DeploymentFileLike = {
  relPath?: string;
  source?: unknown;
  target?: string;
};

type DeploymentManifestLike = {
  files?: DeploymentFileLike[];
};

type DeploymentByModTypeLike = Record<string, unknown>;

/**
 * Vortex emits did-deploy's second argument as either the historical
 * `{ files: IDeployedFile[] }` wrapper or its current map of mod-type IDs to
 * `IDeployedFile[]`. Preserve the resolver's strict file/source checks below;
 * this only normalizes the container shape.
 */
function deploymentFiles(deployment: unknown): DeploymentFileLike[] {
  const wrapped = (deployment as DeploymentManifestLike | undefined)?.files;
  if (Array.isArray(wrapped)) return wrapped;

  if (
    !deployment
    || typeof deployment !== 'object'
    || Array.isArray(deployment)
  ) return [];

  return Object.values(deployment as DeploymentByModTypeLike)
    .filter(Array.isArray)
    .flat() as DeploymentFileLike[];
}

/**
 * Provenance eligibility for mods.txt adoption (Package-03 review fix). A
 * manifest file may contribute a UE4SS mod dir only when its source resolves to
 * an installed, active-profile-enabled MS2 mod of one of these types:
 * - direct consumer types ship ue4ss/Mods/<Mod>/... payloads;
 * - carrier types (root / content folder) are eligible because Package 02 proved
 *   Nexus mods 3/7/11 install as mortalshell2-root while containing UE4SS Lua
 *   mods — but their files must still carry strong Scripts evidence below.
 * Framework/non-consumer types (ue4ss-framework, dml-*, logicmods*, pak,
 * binaries, reshade-preset) are deliberately excluded: their ue4ss/Mods/* files
 * are package internals and must never be adopted as independent mods.
 */
const UE4SS_CONSUMER_SOURCE_TYPES = new Set([
  'mortalshell2-ue4ss-mod',
  'mortalshell2-ue4ss-tree',
]);

const UE4SS_CARRIER_SOURCE_TYPES = new Set([
  'mortalshell2-root',
  'mortalshell2-contentfolder',
]);

/**
 * Canonical UE4SS mod script layout per source mod type (Package-03 review fix,
 * round 2). A manifest relPath is relative to the resolved target of that mod
 * type (game.yaml getPath), so each type has exactly one canonical shape:
 *   mortalshell2-ue4ss-mod     → ue4ss/Mods      : <M>/Scripts/*.lua
 *   mortalshell2-ue4ss-tree    → ue4ss           : Mods/<M>/Scripts/*.lua
 *   mortalshell2-root          → game install root: MortalShell2/Binaries/Win64/ue4ss/Mods/<M>/Scripts/*.lua
 *   mortalshell2-contentfolder → Content folder  : Binaries/Win64/ue4ss/Mods/<M>/Scripts/*.lua
 * Anything else (Tools/, Engine/, arbitrary subtrees, extra depth) is not UE4SS
 * mod evidence and must never derive a mods.txt entry.
 */
const UE4SS_MOD_SCRIPT_SHAPES: Record<string, RegExp> = {
  'mortalshell2-ue4ss-mod': /^([^/]+)\/scripts\/[^/]+\.lua$/i,
  'mortalshell2-ue4ss-tree': /^mods\/([^/]+)\/scripts\/[^/]+\.lua$/i,
  'mortalshell2-root': /^MortalShell2\/Binaries\/Win64\/ue4ss\/Mods\/([^/]+)\/Scripts\/[^/]+\.lua$/i,
  'mortalshell2-contentfolder': /^Binaries\/Win64\/ue4ss\/Mods\/([^/]+)\/Scripts\/[^/]+\.lua$/i,
};

function strongUe4ssModDir(
  modType: string | undefined,
  relPath: unknown,
): string | undefined {
  const pattern = modType ? UE4SS_MOD_SCRIPT_SHAPES[modType] : undefined;
  if (!pattern || typeof relPath !== 'string') return undefined;

  return norm(relPath).match(pattern)?.[1];
}

/**
 * Strict active-profile enablement for Package-03 provenance (shared with the
 * Package-04 reactive decision adapter): resolve exactly
 * persistent.profiles[activeProfileId], require it to be a Mortal Shell II
 * profile, and require modState[modId].enabled === true in that profile.
 * Never falls back to another MS2 profile — legacy UX helpers may search, but
 * ownership reconciliation must not (a non-active profile enabling a mod is not
 * evidence for this deployment). Missing/other-game active profile yields false;
 * no state read failure ever reads as enabled.
 */
type ActiveProfileLike = {
  gameId?: string;
  modState?: Record<string, { enabled?: boolean }>;
};

export function getActiveMs2Profile(
  api: types.IExtensionApi | undefined,
): ActiveProfileLike | undefined {
  if (!api) return undefined;

  let state: unknown;
  try {
    state = api.getState();
  } catch {
    return undefined;
  }

  const s = state as {
    settings?: { profiles?: { activeProfileId?: unknown } };
    persistent?: { profiles?: Record<string, ActiveProfileLike> };
  };

  const id = s?.settings?.profiles?.activeProfileId;
  if (typeof id !== 'string' || id.length === 0) return undefined;

  const profile = s?.persistent?.profiles?.[id];
  return profile?.gameId === GAME_ID ? profile : undefined;
}

function strictActiveProfileModEnabled(
  api: types.IExtensionApi | undefined,
  modId: string,
): boolean {
  return getActiveMs2Profile(api)?.modState?.[modId]?.enabled === true;
}

type ResolvedSourceMod = {
  modId: string;
  type?: string;
  state?: string;
};

/**
 * Vortex stores IDeployedFile.source as the mod's installationPath — see vortex
 * InstallManager ("that's what the deployment manifest's IDeployedFile.source
 * field stores") and modActivation passing mod.installationPath to activate().
 * It can differ from the persistent dictionary key (update-via-replace), so
 * resolve by matching installed mods on installationPath. Sources claimed by
 * zero or two+ mods are unresolvable/ambiguous and must never be adopted.
 */
function indexMs2ModsBySource(api: types.IExtensionApi): Map<string, ResolvedSourceMod[]> {
  const index = new Map<string, ResolvedSourceMod[]>();

  try {
    const state = api.getState() as {
      persistent?: { mods?: Record<string, Record<string, unknown>> };
    };
    const table = state?.persistent?.mods?.[GAME_ID] ?? {};

    for (const [modId, mod] of Object.entries(table)) {
      if (!mod || typeof mod !== 'object') continue;
      const record = mod as { installationPath?: unknown; type?: unknown; state?: unknown };
      if (typeof record.installationPath !== 'string' || record.installationPath.length === 0) {
        continue;
      }

      const list = index.get(record.installationPath) ?? [];
      list.push({
        modId,
        type: typeof record.type === 'string' ? record.type : undefined,
        state: typeof record.state === 'string' ? record.state : undefined,
      });
      index.set(record.installationPath, list);
    }
  } catch {
    // Unreadable state → no resolvable sources; adoption stays conservative.
  }

  return index;
}

/** Installed-mod metadata the Package-04 reactive engine needs (labels, identity). */
export type InstalledModLike = {
  id?: string;
  type?: string;
  state?: string;
  installationPath?: string;
  attributes?: {
    modId?: number;
    fileId?: number;
    name?: string;
    modName?: string;
    source?: string;
    [key: string]: unknown;
  };
};

/**
 * Persistent-id lookup for installed-mod metadata. Deliberately separate from
 * `indexMs2ModsBySource`: provenance resolution stays installationPath-keyed,
 * while the decision adapter needs the dictionary record (type/attributes).
 */
export function getInstalledMod(
  api: types.IExtensionApi | undefined,
  modId: string,
): InstalledModLike | undefined {
  if (!api) return undefined;

  try {
    const state = api.getState() as {
      persistent?: {
        mods?: Record<string, Record<string, InstalledModLike>>;
      };
    };
    return state.persistent?.mods?.[GAME_ID]?.[modId];
  } catch {
    return undefined;
  }
}

/** One resolved mod from the shared provenance pass, with its normalized relPaths. */
export type ResolvedActiveDeploymentMod = {
  modId: string;
  type?: string;
  files: string[];
};

/**
 * Single deployment-provenance resolution shared by BOTH consumers:
 * Package-03 mods.txt reconciliation (deployedUe4ssModDirs) and the Package-04
 * reactive dependency decision adapter. Contract (Package-03, accepted):
 * - IDeployedFile.source == installed mod installationPath (NOT the persistent key);
 * - zero or two+ claimants for a source are unresolvable/ambiguous → skipped;
 * - 'uninstalled' records and mods not strictly enabled in the ACTIVE MS2 profile
 *   never contribute (no fallback to other profiles, no name/path guessing).
 * Type eligibility is deliberately NOT applied here — it is policy of each
 * consumer (mods.txt adoption keeps its UE4SS consumer/carrier filter; the
 * decision adapter classifies by modType/role sets instead).
 */
export function resolveActiveDeploymentMods(
  api: types.IExtensionApi | undefined,
  deployment: unknown,
): Map<string, ResolvedActiveDeploymentMod> {
  const result = new Map<string, ResolvedActiveDeploymentMod>();

  if (!api) return result;

  const files = deploymentFiles(deployment);
  if (files.length === 0) return result;

  const bySource = indexMs2ModsBySource(api);
  if (bySource.size === 0) return result;

  for (const file of files) {
    if (!file || typeof file !== 'object') continue;
    if (typeof file.source !== 'string' || file.source.length === 0) continue;
    if (typeof file.relPath !== 'string' || file.relPath.length === 0) continue;

    const candidates = bySource.get(file.source);
    if (!candidates || candidates.length !== 1) continue; // unresolvable/ambiguous → skip
    const sourceMod = candidates[0];
    if (sourceMod.state === 'uninstalled') continue;
    if (!strictActiveProfileModEnabled(api, sourceMod.modId)) continue;

    const entry = result.get(sourceMod.modId) ?? {
      modId: sourceMod.modId,
      type: sourceMod.type,
      files: [],
    };
    entry.files.push(norm(file.relPath));
    result.set(sourceMod.modId, entry);
  }

  return result;
}

/**
 * UE4SS mod directory names that this deployment actually delivered, derived
 * only from provenance-resolved manifest files via the shared resolution pass:
 * each file's source must resolve unambiguously to an installed MS2 mod strictly
 * enabled in the ACTIVE MS2 profile (no fallback to other profiles) whose type is
 * eligible for independent UE4SS mods, and the path must match that type's
 * canonical UE4SS mod script layout. Manual directories on disk are NOT deployment
 * evidence and must never be inferred here; framework internals (shared libs,
 * bundled loader mods) never qualify.
 */
export function deployedUe4ssModDirs(
  api: types.IExtensionApi | undefined,
  deployment: unknown,
): string[] {
  const resolved = resolveActiveDeploymentMods(api, deployment);

  const dirs = new Map<string, string>();

  for (const entry of resolved.values()) {
    // Eligibility policy stays with mods.txt adoption: framework/non-consumer
    // internals are never adopted even though the shared resolver sees them.
    const eligibleType =
      UE4SS_CONSUMER_SOURCE_TYPES.has(entry.type ?? '')
      || UE4SS_CARRIER_SOURCE_TYPES.has(entry.type ?? '');
    if (!eligibleType) continue;

    for (const relPath of entry.files) {
      const name = strongUe4ssModDir(entry.type, relPath);
      if (!name) continue; // no canonical UE4SS mod script evidence for this type → skip

      const key = name.toLowerCase();
      if (!dirs.has(key)) {
        dirs.set(key, name);
      }
    }
  }

  return [...dirs.values()];
}

/**
 * Idempotent mods.txt merge: append only mod directories present in this
 * deployment's manifest as enabled; never erase existing Ultra+/manual lines,
 * comments, or ordering. Exits without writing when the manifest carries no
 * usable UE4SS files or the file cannot be read.
 */
export async function regenerateModsTxt(ctx: {
  profileId: string;
  deployment: unknown;
  api: unknown;
}): Promise<void> {
  const api = ctx.api as types.IExtensionApi;
  if (getActiveGameId(api) !== GAME_ID) return;
  const discovery = getDiscovery(api);
  if (!discovery?.path) return;

  const modsDir = ue4ssModsDir(discovery.path);
  const requiredDirs = deployedUe4ssModDirs(api, ctx.deployment);
  if (requiredDirs.length === 0) return;

  let existing = '';
  try {
    existing = await readFile(join(modsDir, 'mods.txt'), 'utf8');
  } catch (err) {
    if (nodeErrorCode(err) !== 'ENOENT') {
      log('warn', 'mortalshell2: unable to read mods.txt; leaving it unchanged', {
        err: err instanceof Error ? err.message : String(err),
      });
      return;
    }
  }

  const existingNames = new Set<string>();

  for (const line of existing.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (
      trimmed.length === 0
      || trimmed.startsWith('#')
      || trimmed.startsWith(';')
    ) {
      continue;
    }

    const match = line.match(/^\s*([^:]+?)\s*:/);
    if (match?.[1]) {
      existingNames.add(match[1].trim().toLowerCase());
    }
  }

  const missing = requiredDirs.filter(
    (name) => !existingNames.has(name.toLowerCase()),
  );

  if (missing.length === 0) {
    return;
  }

  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const prefix =
    existing.length === 0
      ? ''
      : existing.endsWith('\n')
        ? existing
        : existing + eol;

  const next =
    prefix
    + missing.map((name) => `${name} : 1`).join(eol)
    + eol;

  await fs.writeFileAsync(join(modsDir, 'mods.txt'), next);
}

/** Standard local ReShade proxy module names (installed under graphics-API filenames). */
const RESHADE_PROXY_DLLS = new Set([
  'd3d9.dll',
  'd3d10.dll',
  'd3d11.dll',
  'd3d12.dll',
  'dxgi.dll',
  'ddraw.dll',
  'opengl32.dll',
]);

/**
 * A valid local ReShade runtime requires BOTH the per-game ReShade.ini AND at least
 * one standard proxy module beside the shipping exe. Either marker alone is not
 * proof: a stale ReShade.ini can survive a broken/uninstalled runtime, and MS2 Nexus
 * mod 2 ships its own dxgi.dll that is NOT ReShade's. Any preset .ini (name merely
 * containing "reshade") never counts as the runtime config — only an exact
 * ReShade.ini does. File names only, case-insensitive; no PE inspection.
 */
export async function hasReShadeRuntime(discoveryPath: string): Promise<boolean> {
  let entries: string[];
  try {
    entries = await readdir(win64(discoveryPath));
  } catch {
    return false;
  }

  const names = new Set(entries.map((e) => e.toLowerCase()));
  return (
    names.has('reshade.ini') && [...names].some((n) => RESHADE_PROXY_DLLS.has(n))
  );
}

/**
 * True when a deployed ReShade preset .ini sits in Win64. ReShade's own config
 * (reshade.ini) is excluded — that belongs to the runtime, not a preset mod.
 */
export async function hasReShadePresetOnDisk(discoveryPath: string): Promise<boolean> {
  try {
    const entries = await readdir(win64(discoveryPath));
    return entries.some(
      (e) => /\.ini$/i.test(e) && /reshade/i.test(e) && !/^reshade\.ini$/i.test(e),
    );
  } catch {
    return false;
  }
}

function dismissNotification(api: types.IExtensionApi, id: string): void {
  const anyApi = api as types.IExtensionApi & {
    dismissNotification?: (nid: string) => void;
  };
  anyApi.dismissNotification?.(id);
}

/**
 * ReShade preset mods ship only the preset .ini. When one is deployed/enabled and
 * no normal ReShade install is detected beside the shipping exe, point at the
 * official site so the user installs the latest ReShade for this game. Dismissed
 * again once the runtime appears or no preset remains.
 */
export async function notifyMissingReShade(api: types.IExtensionApi): Promise<void> {
  if (getActiveGameId(api) !== GAME_ID) return;
  const discovery = getDiscovery(api);
  if (!discovery?.path) return;

  // Vortex mod-type state can lag — also trust a preset .ini already in Win64.
  if (!hasEnabledReShadeDependentMod(api) && !(await hasReShadePresetOnDisk(discovery.path))) {
    dismissNotification(api, 'mortalshell2-need-reshade');
    return;
  }
  if (await hasReShadeRuntime(discovery.path)) {
    dismissNotification(api, 'mortalshell2-need-reshade');
    return;
  }

  const anyApi = api as types.IExtensionApi & {
    sendNotification?: (n: Record<string, unknown>) => void;
  };
  if (typeof anyApi.sendNotification !== 'function') return;
  anyApi.sendNotification({
    id: 'mortalshell2-need-reshade',
    type: 'warning',
    title: 'ReShade is required',
    message:
      'This mod needs ReShade to work. Install it from reshade.me, select ' +
      'MortalShell2-Win64-Shipping.exe, then restart the game.',
    noDismiss: true,
    actions: [
      {
        title: 'Open ReShade downloads',
        action: (dismiss: () => void) => {
          void util.opn(RESHADE_SITE).finally(() => dismiss());
        },
      },
      {
        title: 'Dismiss',
        action: (dismiss: () => void) => dismiss(),
      },
    ],
  });
}

/** did-deploy: reconcile mods.txt, then run independent reactive/ReShade UX. */
export async function afterDeploy(ctx: {
  profileId: string;
  deployment: unknown;
  api: unknown;
}): Promise<void> {
  await regenerateModsTxt(ctx);
  try {
    await processReactiveDependencies(ctx);
  } catch (err) {
    log('warn', 'mortalshell2: reactive dependency processing failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
  try {
    await notifyMissingReShade(ctx.api as types.IExtensionApi);
  } catch (err) {
    log('warn', 'mortalshell2: reshade notify failed', {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Vortex 2.4+ IModHealthCheck shape. Missing `triggers` (array) crashes the
 * HealthCheckRegistry (`triggers.forEach` on undefined) and bricks Vortex startup.
 * Use `checkMod(api, modCtx)` — not the old `(mod, instructions, api)` form.
 */
type ModCheckCtx = {
  modId?: string;
  files?: string[];
  attributes?: Record<string, unknown>;
};

type HealthResult = {
  checkId: string;
  status: 'passed' | 'failed' | 'warning' | 'error';
  severity: 'info' | 'warning' | 'error' | 'critical';
  message: string;
  details?: string;
  executionTime: number;
  timestamp: Date;
};

type NexusFileInfo = {
  file_id?: number;
  fileId?: number;
  is_primary?: boolean;
  category_id?: number;
  name?: string;
  file_name?: string;
};

function passResult(id: string, message = 'OK'): HealthResult {
  return {
    checkId: id,
    status: 'passed',
    severity: 'info',
    message,
    executionTime: 0,
    timestamp: new Date(),
  };
}

function failResult(
  id: string,
  message: string,
  severity: HealthResult['severity'] = 'warning',
): HealthResult {
  return {
    checkId: id,
    status: 'failed',
    severity,
    message,
    executionTime: 0,
    timestamp: new Date(),
  };
}

/** Pick a Nexus file id to download (exported for unit tests). */
export function pickNexusMainFile(
  files: NexusFileInfo[],
  nameHint: RegExp = /bpmodloader|ue4ss/i,
): number | null {
  if (!files?.length) return null;
  const primary =
    files.find((f) => f.is_primary) ??
    files.find((f) => nameHint.test(f.file_name ?? f.name ?? '')) ??
    files.find((f) => f.category_id === 1) ??
    files[0];
  const id = primary?.file_id ?? primary?.fileId;
  return typeof id === 'number' && id > 0 ? id : null;
}

async function emitAndAwait(
  api: types.IExtensionApi,
  event: string,
  ...args: unknown[]
): Promise<unknown> {
  const anyApi = api as types.IExtensionApi & {
    emitAndAwait?: (ev: string, ...a: unknown[]) => Promise<unknown>;
    events: {
      emit: (ev: string, ...a: unknown[]) => void;
      on: (ev: string, handler: (...a: unknown[]) => void) => void;
    };
  };
  if (typeof anyApi.emitAndAwait === 'function') {
    return anyApi.emitAndAwait(event, ...args);
  }
  return new Promise((resolve, reject) => {
    try {
      anyApi.events.emit(event, ...args, (err: Error | null, result: unknown) => {
        if (err) reject(err);
        else resolve(result);
      });
    } catch (err) {
      reject(err);
    }
  });
}

function notify(
  api: types.IExtensionApi,
  type: 'info' | 'success' | 'warning' | 'error',
  message: string,
  opts: Record<string, unknown> = {},
): void {
  const anyApi = api as types.IExtensionApi & {
    sendNotification?: (n: Record<string, unknown>) => void;
  };
  if (typeof anyApi.sendNotification === 'function') {
    anyApi.sendNotification({
      id: (opts.id as string) ?? 'mortalshell2-framework-fix',
      type,
      message,
      displayMS: type === 'error' ? 10000 : 6000,
      ...opts,
    });
  } else {
    log(type === 'error' ? 'error' : 'info', `mortalshell2: ${message}`);
  }
}

async function installNexusMod(
  api: types.IExtensionApi,
  modId: number,
  opts: {
    label: string;
    nameHint: RegExp;
    successHint: string;
    notifyId: string;
  },
): Promise<void> {
  const domain = 'mortalshell2';
  const pageUrl = `https://www.nexusmods.com/${domain}/mods/${modId}?tab=files`;
  const anyApi = api as types.IExtensionApi & {
    ext?: { ensureLoggedIn?: () => Promise<void> };
  };

  try {
    if (typeof anyApi.ext?.ensureLoggedIn === 'function') {
      await anyApi.ext.ensureLoggedIn();
    }

    const raw = await emitAndAwait(api, 'get-mod-files', domain, modId);
    const files: NexusFileInfo[] = Array.isArray(raw)
      ? raw
      : ((raw as { files?: NexusFileInfo[] })?.files ?? []);
    const fileId = pickNexusMainFile(files, opts.nameHint);

    if (fileId == null) {
      notify(
        api,
        'warning',
        `Vortex could not choose a ${opts.label} download. The Nexus Mods download page is opening; ` +
        'choose the file recommended by the mod author.',
        { id: opts.notifyId },
      );
      await util.opn(pageUrl);
      return;
    }

    notify(api, 'info', `Vortex is downloading ${opts.label} from Nexus Mods.`, {
      id: opts.notifyId,
    });
    await emitAndAwait(api, 'nexus-download', domain, modId, fileId);
    notify(api, 'success', opts.successHint, { id: opts.notifyId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('warn', `mortalshell2: ${opts.label} auto-download failed; opening Nexus page`, {
      err: msg,
      modId,
    });
    notify(
      api,
      'warning',
      'Vortex could not start the download. The Nexus Mods download page is opening; ' +
      'download and install the file manually.',
      { id: opts.notifyId },
    );
    try {
      await util.opn(pageUrl);
    } catch {
      // ignore
    }
  }
}

/** Download UE4SS runtime from Nexus (mortalshell2/mods/5) — includes BPModLoaderMod. */
export async function installUe4ssFromNexus(api: types.IExtensionApi): Promise<void> {
  await installNexusMod(api, UE4SS_NEXUS_MOD_ID, {
    label: 'UE4SS',
    nameHint: /ue4ss/i,
    successHint:
      'UE4SS download started. When it finishes, install and enable it in Vortex, then redeploy your mods.',
    notifyId: 'mortalshell2-ue4ss-fix',
  });
}

/** Download DmgModLoader from Nexus (mortalshell2/mods/4) → Content/Paks/dml/. */
export async function installDmlFromNexus(api: types.IExtensionApi): Promise<void> {
  await installNexusMod(api, DML_NEXUS_MOD_ID, {
    label: 'DmgModLoader (DML)',
    nameHint: /dml/i,
    successHint:
      'DML download started. When it finishes, install and enable it in Vortex, then redeploy your mods.',
    notifyId: 'mortalshell2-dml-fix',
  });
}

const LOGIC_MOD_TYPES = new Set([
  'mortalshell2-logicmods',
  'mortalshell2-logicmods-tree',
]);

const UE4SS_DEPENDENT_MOD_TYPES = new Set([
  'mortalshell2-ue4ss-mod',
  'mortalshell2-ue4ss-tree',
]);

const RESHADE_PRESET_MOD_TYPES = new Set(['mortalshell2-reshade-preset']);
const RESHADE_BINARY_ADDON_MOD_TYPES = new Set(['mortalshell2-binaries']);

/**
 * Package-04 dependency role sets (verified against live game.yaml modTypes).
 * `mortalshell2-reshade-preset` is 'none' for the UE4SS/DML engine only — its
 * separate Package-02 ReShade notification behavior is untouched. Carrier roles
 * keep root/content distinct so dependencies.ts can enforce each canonical path
 * shape without hard-coding ids here.
 */
const NO_FRAMEWORK_DEPENDENCY_TYPES = new Set([
  'mortalshell2-pak',
  'mortalshell2-binaries',
  'mortalshell2-reshade-preset',
  'mortalshell2-unsupported',
  'mortalshell2-ue4ss-framework',
  'mortalshell2-dml-framework',
  'mortalshell2-dml-tree',
]);

const ROOT_CARRIER_TYPES = new Set(['mortalshell2-root']);
const CONTENT_CARRIER_TYPES = new Set(['mortalshell2-contentfolder']);

export const MOD_TYPE_GROUPS = {
  logic: LOGIC_MOD_TYPES,
  ue4ss: UE4SS_DEPENDENT_MOD_TYPES,
  noDependency: NO_FRAMEWORK_DEPENDENCY_TYPES,
  rootCarrier: ROOT_CARRIER_TYPES,
  contentCarrier: CONTENT_CARRIER_TYPES,
} as const;

/** One reactive dependency outcome for a single installed mod. */
export type DependencyAdapterResult = {
  dependency: DependencyKind;
  decision: DependencyDecision;
  label: string;
  identity: string;
  nexusModId?: number;
  ue4ssOwnership?: Ue4ssOwnership;
};

type NotificationActions = {
  suppressNotification?: (
    id: string,
    suppress: boolean,
  ) => unknown;
};

function getSuppressNotificationAction() {
  return (actions as unknown as NotificationActions).suppressNotification;
}

function notificationSuppressed(
  api: types.IExtensionApi,
  id: string,
): boolean {
  const state = api.getState() as {
    settings?: {
      notifications?: {
        suppress?: Record<string, boolean>;
      };
    };
  };

  return state.settings?.notifications?.suppress?.[id] === true;
}

function dmlActivationNotificationId(identity: string): string {
  return `mortalshell2:dml-activation:${identity}`;
}

function dmlActivationMessage(input: {
  label: string;
  nexusModId?: number;
}): string {
  return (
    `${input.label} is deployed and DML is installed. `
    + 'Some mods need an extra activation step before they work. '
    + "Check the mod author's instructions."
  );
}

function persistReminderSuppression(
  api: types.IExtensionApi,
  id: string,
): boolean {
  const makeAction = getSuppressNotificationAction();
  if (typeof makeAction !== 'function') {
    log(
      'warn',
      'mortalshell2: notification suppression action unavailable; DML activation reminder will not be persisted',
    );
    return false;
  }

  api.store.dispatch(makeAction(id, true) as never);
  return true;
}

function sendDmlActivationReminder(
  api: types.IExtensionApi,
  input: {
    label: string;
    identity: string;
    nexusModId?: number;
  },
): void {
  const id = dmlActivationNotificationId(input.identity);
  if (notificationSuppressed(api, id)) return;

  // Vortex checks notification suppression while displaying the notification.
  // Send before persisting, so this deterministic id remains visible once.
  api.sendNotification({
    id,
    type: 'info',
    title: "Check this mod's activation instructions",
    message: dmlActivationMessage(input),
    allowSuppress: false,
  } as never);

  persistReminderSuppression(api, id);
}

/**
 * Emit one persisted DML activation reminder only for a LogicMod that the
 * reviewed dependency adapter has already determined is satisfied through DML.
 */
export function maybeNotifyDmlActivation(
  api: types.IExtensionApi,
  result: DependencyAdapterResult,
): void {
  if (
    result.dependency !== 'logicmod'
    || result.decision.kind !== 'satisfied'
    || result.decision.loader !== 'dml'
  ) return;

  sendDmlActivationReminder(api, result);
}

/**
 * Enabled installed mods from the one exact active MS2 profile. This is kept
 * separate from deployment provenance: explicit dependency mod types can be
 * assessed even when a current deployment manifest has no paths for them.
 */
function enabledInstalledMods(
  api: types.IExtensionApi,
): Array<[string, InstalledModLike]> {
  const profile = getActiveMs2Profile(api);
  if (!profile) return [];

  try {
    const state = api.getState() as {
      persistent?: { mods?: Record<string, Record<string, InstalledModLike>> };
    };
    const mods = state.persistent?.mods?.[GAME_ID] ?? {};

    return Object.entries(mods).filter(([modId, mod]) =>
      Boolean(mod)
      && mod.state !== 'uninstalled'
      && profile.modState?.[modId]?.enabled === true,
    );
  } catch {
    return [];
  }
}

/** Stable simultaneous de-duplication key; unresolved warnings are never suppressed. */
export function dependencyNotificationId(
  decision: DependencyDecision,
  identity: string,
): string {
  return `mortalshell2:dependency:${decision.kind}:${identity}`;
}

const DEPENDENCY_NOTIFICATION_PREFIX = 'mortalshell2:dependency:';
const UNSUPPORTED_NOTIFICATION_PREFIX = 'mortalshell2:unsupported:';
const UNSUPPORTED_MOD_TYPE = 'mortalshell2-unsupported';

type UnsupportedNotificationInput = {
  label: string;
  identity: string;
  source?: string;
  nexusModId?: number;
  nexusFileId?: number;
};

function unsupportedNotificationId(identity: string): string {
  return `mortalshell2:unsupported:${identity}`;
}

function sendUnsupportedWarning(
  api: types.IExtensionApi,
  input: UnsupportedNotificationInput,
): void {
  const id = unsupportedNotificationId(input.identity);
  if (notificationSuppressed(api, id)) return;

  const notificationApi = api as DependencyNotificationApi;
  if (typeof notificationApi.sendNotification !== 'function') return;

  const hasNexusPage =
    input.source === 'nexus'
    && Number.isInteger(input.nexusModId)
    && Number(input.nexusModId) > 0
    && Number.isInteger(input.nexusFileId)
    && Number(input.nexusFileId) > 0;
  const actions = hasNexusPage
    ? [{
      title: 'View on Nexus Mods',
      action: (dismiss: () => void) => {
        const url = `https://www.nexusmods.com/mortalshell2/mods/${input.nexusModId}`;
        void Promise.resolve()
          .then(() => util.opn(url))
          .catch((err) => {
            log('warn', 'mortalshell2: failed to open unsupported-mod Nexus page', {
              err: err instanceof Error ? err.message : String(err),
              modId: input.nexusModId,
            });
          })
          .finally(dismiss);
      },
    }]
    : [];

  notificationApi.sendNotification({
    id,
    type: 'warning',
    title: "Check this mod's installation instructions",
    message:
      `${input.label} does not look like a mod that should be installed through Vortex. `
      + 'Its files were placed in the default mod folder, but it may not work there. '
      + "Please follow the mod author's installation instructions.",
    allowSuppress: false,
    actions,
  });

  const makeAction = getSuppressNotificationAction();
  if (typeof makeAction !== 'function') {
    log(
      'warn',
      'mortalshell2: notification suppression action unavailable; unsupported-mod warning will not be persisted',
    );
    return;
  }
  api.store.dispatch(makeAction(id, true) as never);
}

type DependencyNotificationInput = {
  label: string;
  identity: string;
  decision: DependencyDecision;
  modId: string;
  files: readonly string[];
  ue4ssOwnership?: Ue4ssOwnership;
};

/**
 * Local GDL's vortex-api declaration and mock leave notifications intentionally
 * opaque, so use their existing record-shaped adapter at this narrow boundary.
 */
type DependencyNotificationApi = types.IExtensionApi & {
  sendNotification?: (notification: Record<string, unknown>) => void;
};

function staleSafeInstallAction(
  api: types.IExtensionApi,
  input: DependencyNotificationInput,
  expectedKind: 'install-dml' | 'install-ue4ss',
): (dismiss: () => void) => void {
  return (dismiss) => {
    dismiss();
    void (async () => {
      if (!strictActiveProfileModEnabled(api, input.modId)) return;

      const current = await dependencyDecisionForInstalledMod(api, input.modId, input.files);
      if (current.decision.kind !== expectedKind) return;

      if (expectedKind === 'install-dml') {
        await installDmlFromNexus(api);
      } else {
        await installUe4ssFromNexus(api);
      }
    })();
  };
}

function sendDependencyNotification(
  api: types.IExtensionApi,
  input: DependencyNotificationInput,
): void {
  const notificationApi = api as DependencyNotificationApi;
  if (typeof notificationApi.sendNotification !== 'function') return;

  const actions: Array<{ title: string; action: (dismiss: () => void) => void }> = [];
  if (input.decision.kind === 'install-dml') {
    actions.push({
      title: 'Install DML',
      action: staleSafeInstallAction(api, input, 'install-dml'),
    });
  } else if (input.decision.kind === 'install-ue4ss') {
    actions.push({
      title: 'Install UE4SS',
      action: staleSafeInstallAction(api, input, 'install-ue4ss'),
    });
  }

  notificationApi.sendNotification({
    id: dependencyNotificationId(input.decision, input.identity),
    type: 'warning',
    title: 'Mod requirement',
    message: dependencyFailureMessage(input.label, input.decision, {
      ue4ssOwnership: input.ue4ssOwnership,
    }),
    allowSuppress: false,
    actions,
  });
}

/**
 * Single Vortex-state → pure-engine adapter (Package-04). Reactive UX, the
 * IModHealthCheck wrapper, and any future consumer all go through here so there
 * is exactly one framework-state decision path: live Package-03 assessments
 * (disk evidence + package provenance) feed the pure decideDependency engine.
 * Explicit LogicMod/UE4SS modTypes classify with `files = []`; carriers need
 * strong staged-file evidence and never scan disk to compensate for missing
 * manifest provenance.
 */
export async function dependencyDecisionForInstalledMod(
  api: types.IExtensionApi,
  modId: string,
  files: readonly string[] = [],
): Promise<DependencyAdapterResult> {
  const installed = getInstalledMod(api, modId);
  const normalizedFiles = files.map((file) => String(file).replace(/\\/g, '/'));

  const dependency = classifyDependency(
    installed?.type,
    normalizedFiles,
    MOD_TYPE_GROUPS,
  );

  const nexusModId =
    typeof installed?.attributes?.modId === 'number'
      ? installed.attributes.modId
      : undefined;

  const label = notificationSafeLabel({
    vortexModId: modId,
    name:
      typeof installed?.attributes?.name === 'string'
        ? installed.attributes.name
        : undefined,
    modName:
      typeof installed?.attributes?.modName === 'string'
        ? installed.attributes.modName
        : undefined,
  });

  const identity = stableModIdentity({
    vortexModId: modId,
    nexusModId,
  });

  if (dependency === 'none') {
    return { dependency, decision: { kind: 'not-applicable' }, label, identity, nexusModId };
  }

  const discovery = getDiscovery(api);
  if (!discovery?.path) {
    return { dependency, decision: { kind: 'not-applicable' }, label, identity, nexusModId };
  }

  const [ue4ss, dml, bp] = await Promise.all([
    assessUe4ssRuntime(discovery.path, api),
    assessDmlRuntime(discovery.path, api),
    assessBpModLoader(discovery.path),
  ]);

  return {
    dependency,
    decision: decideDependency({
      dependency,
      selfContained: detectSelfContainedEvidence(normalizedFiles),
      ue4ss,
      dml,
      bp,
    }),
    label,
    identity,
    nexusModId,
    ue4ssOwnership: ue4ss.ownership,
  };
}

/** IModHealthCheck.checkMod context → the same installed-mod adapter (no second decision path). */
export async function dependencyDecisionForMod(
  api: types.IExtensionApi,
  mod: ModCheckCtx,
): Promise<DependencyAdapterResult> {
  return dependencyDecisionForInstalledMod(
    api,
    mod.modId ?? '',
    (mod.files ?? []).map((file) => String(file).replace(/\\/g, '/')),
  );
}

/** Pure decision → user-facing failure message (shared with reactive notifications later). */
function dependencyFailureMessage(
  label: string,
  decision: DependencyDecision,
  context: {
    ue4ssOwnership?: string;
  } = {},
): string {
  switch (decision.kind) {
    case 'install-dml':
      return `${label} needs DML to run. DML is not installed. Select Install DML to download it, then install and enable it in Vortex.`;
    case 'enable-dml':
      return `${label} needs DML to run. DML is installed in Vortex but is disabled for this profile. Enable it in Vortex, then redeploy your mods.`;
    case 'repair-dml':
      return decision.ownership === 'vortex'
        ? `${label} needs DML to run, but its Vortex installation is incomplete. Repair or reinstall DML in Vortex, then redeploy your mods.`
        : `${label} needs DML to run, but its existing installation is incomplete. Repair that installation, then redeploy your mods.`;
    case 'install-ue4ss':
      return `${label} needs UE4SS to run. UE4SS is not installed. Select Install UE4SS to download it, then install and enable it in Vortex.`;
    case 'enable-ue4ss':
      return `${label} needs UE4SS to run. UE4SS is installed in Vortex but is disabled for this profile. Enable it in Vortex, then redeploy your mods.`;
    case 'repair-ue4ss':
      if (context.ue4ssOwnership === 'ultra-managed') {
        return `${label} needs UE4SS to run, but the Ultra+ installation is incomplete. Repair it with Ultra+ Manager, then redeploy your mods.`;
      }
      return decision.ownership === 'vortex'
        ? `${label} needs UE4SS to run, but its Vortex installation is incomplete. Repair or reinstall UE4SS in Vortex, then redeploy your mods.`
        : `${label} needs UE4SS to run, but its existing installation is incomplete. Repair that installation, then redeploy your mods.`;
    default:
      return `${label} dependency is satisfied.`;
  }
}

/**
 * Emit repeatable warnings for enabled installed mods whose framework decision
 * is unresolved, plus one persisted activation reminder for LogicMods that the
 * same decision adapter has determined are satisfied through DML. Deployment
 * provenance is read only from the shared Package-03 resolver.
 */
export async function processReactiveDependencies(ctx: {
  profileId: string;
  deployment: unknown;
  api: unknown;
}): Promise<void> {
  const api = ctx.api as types.IExtensionApi;
  let state: {
    settings?: { profiles?: { activeProfileId?: unknown } };
    persistent?: { profiles?: Record<string, ActiveProfileLike> };
  };
  try {
    state = api.getState() as typeof state;
  } catch {
    return;
  }

  const activeProfileId = state.settings?.profiles?.activeProfileId;
  if (
    typeof activeProfileId !== 'string'
    || activeProfileId.length === 0
    || activeProfileId !== ctx.profileId
    || state.persistent?.profiles?.[activeProfileId]?.gameId !== GAME_ID
  ) return;

  const deployed = resolveActiveDeploymentMods(api, ctx.deployment);
  const desired = new Map<string, DependencyNotificationInput>();
  const unsupported = new Map<string, UnsupportedNotificationInput>();
  const activationReminders: DependencyAdapterResult[] = [];

  for (const [modId, mod] of enabledInstalledMods(api)) {
    if (mod.type === UNSUPPORTED_MOD_TYPE) {
      const nexusModId =
        typeof mod.attributes?.modId === 'number'
          ? mod.attributes.modId
          : undefined;
      const identity = stableModIdentity({ vortexModId: modId, nexusModId });
      const label = notificationSafeLabel({
        vortexModId: modId,
        name: mod.attributes?.name,
        modName: mod.attributes?.modName,
      });
      unsupported.set(unsupportedNotificationId(identity), {
        label,
        identity,
        source: mod.attributes?.source,
        nexusModId,
        nexusFileId: mod.attributes?.fileId,
      });
      continue;
    }

    const files = deployed.get(modId)?.files ?? [];
    const dependency = classifyDependency(mod.type, files, MOD_TYPE_GROUPS);
    if (dependency === 'none') continue;

    const result = await dependencyDecisionForInstalledMod(api, modId, files);
    if (result.decision.kind === 'not-applicable') continue;
    if (result.decision.kind === 'satisfied') {
      if (deployed.has(modId)) {
        activationReminders.push(result);
      }
      continue;
    }

    const input: DependencyNotificationInput = {
      label: result.label,
      identity: result.identity,
      decision: result.decision,
      modId,
      files,
      ue4ssOwnership: result.ue4ssOwnership,
    };
    desired.set(dependencyNotificationId(result.decision, result.identity), input);
  }

  const notificationState = state as {
    session?: { notifications?: { notifications?: Array<{ id?: unknown }> } };
  };
  const activeNotifications = notificationState.session?.notifications?.notifications ?? [];
  for (const notification of activeNotifications) {
    const id = notification?.id;
    if (typeof id !== 'string') continue;
    if (
      (id.startsWith(DEPENDENCY_NOTIFICATION_PREFIX) && !desired.has(id))
      || (id.startsWith(UNSUPPORTED_NOTIFICATION_PREFIX) && !unsupported.has(id))
    ) {
      dismissNotification(api, id);
    }
  }

  for (const input of desired.values()) {
    sendDependencyNotification(api, input);
  }

  for (const input of unsupported.values()) {
    sendUnsupportedWarning(api, input);
  }

  for (const result of activationReminders) {
    maybeNotifyDmlActivation(api, result);
  }
}

/**
 * The one Package-04 per-mod framework dependency diagnostic (Vortex 2.4+
 * IModHealthCheck, checkMod only). Delegates to the shared decision adapter —
 * no independent state interpretation, and deliberately NO `fix`/`fixAvailable`
 * and no game-level `check`: Vortex health checks are per-mod and cannot carry
 * a Fix action in 2.4. Registration stays deferred (see game.yaml TODO) until
 * GDL's lifecycle fake implements registerHealthCheck.
 */
export const modFrameworkDependencyCheck: types.IModHealthCheck = {
  id: 'mortalshell2-mod-framework-dependency',
  name: 'Mortal Shell II mod dependencies',
  description:
    'Checks only installed mods that require UE4SS or a LogicMod loader.',
  category: 'requirements',
  severity: 'warning',
  triggers: [
    'mods-changed',
    'profile-changed',
    'game-changed',
  ],
  gameId: GAME_ID,
  checkMod: async (
    api: types.IExtensionApi,
    mod: ModCheckCtx,
  ) => {
    const started = Date.now();
    const result = await dependencyDecisionForMod(api, mod);

    if (
      result.decision.kind === 'not-applicable'
      || result.decision.kind === 'satisfied'
    ) {
      return {
        checkId: 'mortalshell2-mod-framework-dependency',
        status: 'passed',
        severity: 'info',
        message:
          result.decision.kind === 'not-applicable'
            ? 'No optional framework dependency.'
            : 'Required framework dependency is satisfied.',
        executionTime: Date.now() - started,
        timestamp: new Date(),
      };
    }

    return {
      checkId: 'mortalshell2-mod-framework-dependency',
      status: 'failed',
      severity: 'warning',
      message: dependencyFailureMessage(
        result.label,
        result.decision,
        {
          ue4ssOwnership: result.ue4ssOwnership,
        },
      ),
      executionTime: Date.now() - started,
      timestamp: new Date(),
    };
  },
};

function profileModEnabled(
  api: types.IExtensionApi,
  modId: string,
): boolean | undefined {
  const state = api.getState() as {
    persistent?: {
      profiles?: Record<
        string,
        { gameId?: string; modState?: Record<string, { enabled?: boolean }> }
      >;
    };
    settings?: { profiles?: { activeProfileId?: string } };
  };
  const profileId = state?.settings?.profiles?.activeProfileId;
  const profile = profileId ? state?.persistent?.profiles?.[profileId] : undefined;
  const profileForGame =
    profile?.gameId === GAME_ID
      ? profile
      : Object.values(state?.persistent?.profiles ?? {}).find((p) => p?.gameId === GAME_ID);
  return profileForGame?.modState?.[modId]?.enabled;
}

function hasEnabledModOfTypes(
  api: types.IExtensionApi,
  typesSet: Set<string>,
): boolean {
  const state = api.getState() as {
    persistent?: {
      mods?: Record<string, Record<string, { type?: string; state?: string }>>;
    };
  };
  const mods = state?.persistent?.mods?.[GAME_ID] ?? {};
  for (const [modId, mod] of Object.entries(mods)) {
    if (!mod || mod.state === 'uninstalled') continue;
    if (!typesSet.has(mod.type ?? '')) continue;
    if (profileModEnabled(api, modId) === false) continue;
    return true;
  }
  return false;
}

/** True when Vortex has an enabled ReShade preset mod for this game. */
export function hasEnabledReShadePreset(api: types.IExtensionApi): boolean {
  return hasEnabledModOfTypes(api, RESHADE_PRESET_MOD_TYPES);
}

function hasEnabledReShadeDependentMod(api: types.IExtensionApi): boolean {
  return (
    hasEnabledReShadePreset(api)
    || hasEnabledModOfTypes(api, RESHADE_BINARY_ADDON_MOD_TYPES)
  );
}

function modFiles(mod: ModCheckCtx | undefined): string[] {
  return (mod?.files ?? []).map((f) => String(f).replace(/\\/g, '/'));
}

function hasDest(files: string[], name: string): boolean {
  const lower = name.toLowerCase();
  return files.some(
    (f) =>
      f.toLowerCase() === lower ||
      f.toLowerCase().endsWith(`/${lower}`) ||
      basename(f).toLowerCase() === lower,
  );
}

function makeModHealthCheck(spec: {
  id: string;
  name: string;
  description: string;
  severity?: HealthResult['severity'];
  check: (
    api: types.IExtensionApi,
    files: string[],
  ) => Promise<{ ok: boolean; message?: string; severity?: HealthResult['severity'] }>;
}): types.IModHealthCheck {
  const severity = spec.severity ?? 'warning';
  return {
    id: spec.id,
    name: spec.name,
    description: spec.description,
    category: 'mods',
    severity,
    triggers: ['mods-changed', 'game-changed', 'startup'],
    gameId: GAME_ID,
    checkMod: async (api: types.IExtensionApi, mod: ModCheckCtx) => {
      const result = await spec.check(api, modFiles(mod));
      if (result.ok) {
        return passResult(spec.id, result.message ?? 'OK');
      }
      return failResult(spec.id, result.message ?? 'Failed', result.severity ?? severity);
    },
  };
}

/** Partial runtime / nested paths / Vortex takeover of external UE4SS. */
export const ue4ssOwnershipCheck = makeModHealthCheck({
  id: 'mortalshell2-ue4ss-ownership',
  name: 'UE4SS ownership and integrity',
  description:
    'Detects partial runtimes, nested path bugs, and Vortex framework packages that would overwrite an external runtime.',
  severity: 'error',
  check: async (api, files) => {
    const issues: string[] = [];
    if (files.some((f) => /\/ue4ss\/mods\/ue4ss\/mods\//i.test(f))) {
      issues.push('Duplicated ue4ss/Mods nesting detected in deploy plan.');
    }
    if (files.some((f) => /pakchunk\d+-windows\.(pak|ucas|utoc)$/i.test(f))) {
      issues.push('Mod attempts to deploy stock pakchunk* game archives.');
    }

    const deploysRuntime =
      hasDest(files, 'dwmapi.dll') || files.some((f) => /ue4ss\.dll$/i.test(f));

    if (deploysRuntime) {
      const discovery = getDiscovery(api);
      if (discovery?.path) {
        const assessment = await assessUe4ssRuntime(discovery.path, api);
        if (
          assessment.health === 'healthy' &&
          (assessment.ownership === 'externally-managed' ||
            assessment.ownership === 'ultra-managed')
        ) {
          issues.push(
            'A Vortex UE4SS runtime package would overwrite an externally managed runtime ' +
              `(${assessment.ownership}). Cancel the Vortex runtime install, or remove the external ` +
              'runtime manually and retry. Vortex will not delete external files automatically. ' +
              (assessment.ownership === 'ultra-managed'
                ? 'Repair UE4SS through Ultra+ Manager instead.'
                : ''),
          );
        }
        if (assessment.health === 'partial') {
          issues.push(assessment.guidance ?? ue4ssGuidance(assessment));
        }
      }
    }

    if (files.filter((f) => /\.addon64$/i.test(f)).length > 1) {
      issues.push(
        'Multiple RenoDX .addon64 files in one package — prefer a single implementation.',
      );
    }

    if (issues.length === 0) return { ok: true };
    return { ok: false, message: issues.join(' '), severity: 'error' };
  },
});
