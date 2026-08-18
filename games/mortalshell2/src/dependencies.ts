export type DependencyKind =
  | 'none'
  | 'logicmod'
  | 'ue4ss-mod';

export type LoaderKind =
  | 'dml'
  | 'bpmodloader'
  | 'self-contained';

export type RepairOwnership =
  | 'vortex'
  | 'external';

export type DependencyDecision =
  | { kind: 'not-applicable' }
  | { kind: 'satisfied'; loader?: LoaderKind }
  | { kind: 'install-dml' }
  | { kind: 'enable-dml' }
  | { kind: 'repair-dml'; ownership: RepairOwnership }
  | { kind: 'install-ue4ss' }
  | { kind: 'enable-ue4ss' }
  | { kind: 'repair-ue4ss'; ownership: RepairOwnership };

export interface SelfContainedEvidence {
  ue4ssRuntime: boolean;
  dmlLoader: boolean;
  bpModLoader: boolean;
}

export interface Ue4ssDecisionState {
  health: 'absent' | 'partial' | 'healthy';
  packagePresent: boolean;
  packageEnabled: boolean;
  managedByVortex: boolean;
  ultraPlusDetected: boolean;
  ownership: 'absent' | 'vortex-managed' | 'externally-managed' | 'ultra-managed';
}

export interface DmlDecisionState {
  health: 'absent' | 'partial' | 'healthy';
  packagePresent: boolean;
  packageEnabled: boolean;
  managedByVortex: boolean;
  ownership: 'absent' | 'vortex-managed' | 'externally-managed';
}

export interface BpDecisionState {
  present: boolean;
  enabled: boolean;
}

export interface DecisionInput {
  dependency: DependencyKind;
  selfContained: SelfContainedEvidence;
  ue4ss: Ue4ssDecisionState;
  dml: DmlDecisionState;
  bp: BpDecisionState;
}

function norm(path: string): string {
  return path.replace(/\\/g, '/');
}

function lowerFiles(files: readonly string[]): string[] {
  return files.map((file) => norm(String(file)).toLowerCase());
}

export function classifyDependency(
  modType: string | undefined,
  files: readonly string[],
  modTypes: {
    logic: ReadonlySet<string>;
    ue4ss: ReadonlySet<string>;
    noDependency: ReadonlySet<string>;
    rootCarrier: ReadonlySet<string>;
    contentCarrier: ReadonlySet<string>;
  },
): DependencyKind {
  if (modType && modTypes.logic.has(modType)) return 'logicmod';
  if (modType && modTypes.ue4ss.has(modType)) return 'ue4ss-mod';
  if (modType && modTypes.noDependency.has(modType)) return 'none';

  const normalized = lowerFiles(files);

  if (modType && modTypes.rootCarrier.has(modType)) {
    if (normalized.some((file) =>
      /^mortalshell2\/content\/paks\/logicmods\/[^/]+\//.test(file),
    )) return 'logicmod';

    if (normalized.some((file) =>
      /^mortalshell2\/binaries\/win64\/ue4ss\/mods\/[^/]+\/scripts\/[^/]+\.lua$/.test(file),
    )) return 'ue4ss-mod';

    return 'none';
  }

  if (modType && modTypes.contentCarrier.has(modType)) {
    if (normalized.some((file) =>
      /^content\/paks\/logicmods\/[^/]+\//.test(file),
    )) return 'logicmod';

    if (normalized.some((file) =>
      /^binaries\/win64\/ue4ss\/mods\/[^/]+\/scripts\/[^/]+\.lua$/.test(file),
    )) return 'ue4ss-mod';

    return 'none';
  }

  // Blank, unrecognized, and untyped staged content may use only strong
  // self-describing layouts. All explicit semantic and carrier roles returned
  // above, so their policy remains authoritative over this fallback.
  if (normalized.some((file) =>
    /(^|\/)logicmods\/[^/]+\//.test(file),
  )) return 'logicmod';

  if (normalized.some((file) =>
    /(^|\/)(?:ue4ss\/)?mods\/[^/]+\/scripts\/[^/]+\.lua$/.test(file)
    || /^[^/]+\/scripts\/[^/]+\.lua$/.test(file),
  )) return 'ue4ss-mod';

  return 'none';
}

export function detectSelfContainedEvidence(
  files: readonly string[],
): SelfContainedEvidence {
  const normalized = new Set(lowerFiles(files));

  const hasProxy = [...normalized].some(
    (file) => /(^|\/)dwmapi\.dll$/i.test(file),
  );
  const hasUe4ssCore = [...normalized].some(
    (file) => /(^|\/)ue4ss\/ue4ss\.dll$/i.test(file),
  );

  const hasDmlPak = [...normalized].some(
    (file) => /(^|\/)(?:dml\/)?dml\.pak$/i.test(file),
  );
  const hasDmlUcas = [...normalized].some(
    (file) => /(^|\/)(?:dml\/)?dml\.ucas$/i.test(file),
  );
  const hasDmlUtoc = [...normalized].some(
    (file) => /(^|\/)(?:dml\/)?dml\.utoc$/i.test(file),
  );

  const hasBpPayload = [...normalized].some(
    (file) =>
      /(^|\/)(?:ue4ss\/)?mods\/bpmodloadermod\/scripts\/main\.lua$/i.test(file),
  );
  const hasBpEnabled = [...normalized].some(
    (file) =>
      /(^|\/)(?:ue4ss\/)?mods\/bpmodloadermod\/enabled\.txt$/i.test(file),
  );

  return {
    ue4ssRuntime: hasProxy && hasUe4ssCore,
    dmlLoader: hasDmlPak && hasDmlUcas && hasDmlUtoc,
    bpModLoader: hasBpPayload && hasBpEnabled,
  };
}

export function decideDependency(
  input: DecisionInput,
): DependencyDecision {
  if (input.dependency === 'none') {
    return { kind: 'not-applicable' };
  }

  if (input.dependency === 'logicmod') {
    if (
      input.selfContained.dmlLoader
      || (
        input.selfContained.bpModLoader
        && input.selfContained.ue4ssRuntime
      )
    ) {
      return { kind: 'satisfied', loader: 'self-contained' };
    }

    if (input.bp.present && input.bp.enabled) {
      return { kind: 'satisfied', loader: 'bpmodloader' };
    }

    if (input.dml.health === 'healthy') {
      return { kind: 'satisfied', loader: 'dml' };
    }

    if (
      input.dml.packagePresent
      && !input.dml.packageEnabled
      && input.dml.health === 'absent'
    ) {
      return { kind: 'enable-dml' };
    }

    if (input.dml.health === 'partial') {
      return {
        kind: 'repair-dml',
        ownership: input.dml.managedByVortex ? 'vortex' : 'external',
      };
    }

    return { kind: 'install-dml' };
  }

  if (input.selfContained.ue4ssRuntime) {
    return { kind: 'satisfied', loader: 'self-contained' };
  }

  if (input.ue4ss.health === 'healthy') {
    return { kind: 'satisfied' };
  }

  if (
    input.ue4ss.packagePresent
    && !input.ue4ss.packageEnabled
    && input.ue4ss.health === 'absent'
  ) {
    return { kind: 'enable-ue4ss' };
  }

  if (input.ue4ss.health === 'partial') {
    return {
      kind: 'repair-ue4ss',
      ownership: input.ue4ss.managedByVortex ? 'vortex' : 'external',
    };
  }

  return { kind: 'install-ue4ss' };
}

export function stableModIdentity(input: {
  vortexModId: string;
  nexusModId?: number;
}): string {
  if (
    Number.isInteger(input.nexusModId)
    && Number(input.nexusModId) > 0
  ) {
    return `nexus-mortalshell2-${input.nexusModId}`;
  }

  return `vortex-${encodeURIComponent(input.vortexModId)}`;
}

export function notificationSafeLabel(input: {
  vortexModId: string;
  name?: string;
  modName?: string;
}): string {
  return (
    input.name?.trim()
    || input.modName?.trim()
    || input.vortexModId
  );
}
