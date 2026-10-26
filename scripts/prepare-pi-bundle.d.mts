export interface PreparePiBundleTarget {
  /** npm guest operating system name, e.g. `linux` */
  os: string;
  /** npm guest CPU architecture name, e.g. `arm64` */
  cpu: string;
  /** Guest C library name, e.g. `musl` for Alpine */
  libc: string;
}

export interface PreparePiBundleOptions {
  /** repository root (default: cwd) */
  repoRoot?: string;
  /** image build config path, relative to `repoRoot` */
  config: string;
  /** bundle output directory, relative to `repoRoot` */
  out?: string;
  /** `<repoKey>=<repoDir>` dependency trees to bake into `/pi-deps/<repoKey>` */
  deps?: string[];
  os?: string;
  cpu?: string;
  libc?: string;
  /** skip `--deps` trees and bake only the runtime bundle */
  noDeps?: boolean;
}

export interface BakedRepo {
  /** Dependency directory key under `/pi-deps`, unique ignoring ASCII case */
  repoKey: string;
  /** SHA-256 of the installed lockfile snapshot, lowercase hex */
  lockfileSha256: string;
  /** Non-root package entries in the installed lockfile snapshot */
  packageCount: number;
  /** OS/CPU-matching optional entries, including skipped libc alternatives */
  platformPackages: number;
}

export interface ImageProvenance {
  schemaVersion: 1;
  target: PreparePiBundleTarget;
  /** Bundle preparation timestamp in ISO 8601 UTC */
  preparedAt: string;
  /** Absolute guest HOME path represented by the generated skeleton */
  guestHome: string;
  piBundle: {
    /** Runtime dependency name from the staged package manifest */
    package: string;
    /** Runtime dependency version specifier from the staged package manifest */
    version: string;
    /** SHA-256 of the installed runtime lockfile snapshot, lowercase hex */
    lockfileSha256: string;
    /** Command names linked into the guest PATH */
    binLinks: string[];
  };
  bakedRepos: BakedRepo[];
  /** System git safe.directory setting for guest-mounted worktrees */
  gitSafeDirectory: string;
  /** Expected command availability, not a guest probe result */
  expectedToolchain: { present: string[]; absent: string[] };
}

export function preparePiBundle(options: PreparePiBundleOptions): {
  outDir: string;
  provenance: ImageProvenance;
};

export function platformEntries(
  lockfilePath: string,
  target: PreparePiBundleTarget,
): Array<{
  key: string;
  meta: Record<string, unknown>;
  dir: string;
  name: string;
}>;

export function assertPlatformTrees(
  nodeModulesDir: string,
  lockfilePath: string,
  target: PreparePiBundleTarget,
): number;

export function parseDepSpecs(specs: string[]): Array<{
  key: string;
  dir: string;
}>;
