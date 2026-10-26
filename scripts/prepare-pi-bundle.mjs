#!/usr/bin/env node

// Prepare the generated inputs for images/pi-node-base.json.
//
// The image config copies a host-side bundle tree into the guest rootfs. This
// script pins npm package resolution with lockfiles and records which inputs
// were installed so a consumer can detect stale baked dependency trees.
//
//   node scripts/prepare-pi-bundle.mjs \
//     --config images/pi-node-base.json \
//     --deps pi-config=/path/to/pi-config
//
// Dependency trees are installed for the guest target (linux/arm64/musl for the
// Alpine guest), not for the build host. Without `--libc=musl` npm skips the
// `*-musl` optional platform packages and the baked tree fails in the guest.

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

import { requireArg } from "./lib/cli.mjs";

const BUNDLE_PACKAGE_DIR = "images/pi-node-base.bundle";
const DEFAULT_OUT_DIR = "images/pi-bundle";
const OWNERSHIP_MARKER = ".gondolin-pi-bundle";
const PREPARE_LOCK = ".gondolin-pi-bundle.lock";
const DEFAULT_TARGET = { os: "linux", cpu: "arm64", libc: "musl" };
const GUEST_NPM_PREFIX = "/usr/local/lib/node_modules";
const EXPECTED_TOOLCHAIN = Object.freeze({
  present: ["pi", "node", "npm", "rg", "git"],
  absent: ["ml", "sd", "gh", "obsidian"],
});

function usage() {
  return [
    "Usage: node scripts/prepare-pi-bundle.mjs --config <build-config.json> [options]",
    "",
    "Options:",
    "  --config <path>        Image build config (env.HOME selects the HOME skeleton path)",
    "  --out <dir>            Output inside the repo (default: images/pi-bundle)",
    "                        Existing outputs require a bundle ownership marker",
    "                        One preparation per repo; stale locks need manual cleanup",
    "  --deps <key>=<dir>     Repo whose lockfile is baked as /pi-deps/<key> (repeatable)",
    "  --os <name>            Dependency target os (default: linux)",
    "  --cpu <name>           Dependency target cpu (default: arm64)",
    "  --libc <name>          Dependency target libc (default: musl)",
    "  --no-deps              Skip --deps trees (runtime bundle only)",
    "  --help                 Show this help",
  ].join("\n");
}

function containsPath(parent, child) {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

// Resolve symlinked inputs even when their final path does not exist yet.
function canonicalPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    // A dangling symlink is not a safe missing directory.
    if (fs.lstatSync(filePath, { throwIfNoEntry: false })) throw error;
    return path.join(
      canonicalPath(path.dirname(filePath)),
      path.basename(filePath),
    );
  }
}

// realpath does not normalize casing on every filesystem. Compare identities
// along existing ancestors as well, without guessing filesystem case rules.
function physicallyContains(parent, child) {
  const parentStat = fs.statSync(parent, { throwIfNoEntry: false });
  if (!parentStat) return false;
  let current = child;
  for (;;) {
    const stat = fs.statSync(current, { throwIfNoEntry: false });
    if (stat && stat.dev === parentStat.dev && stat.ino === parentStat.ino) {
      return true;
    }
    const next = path.dirname(current);
    if (next === current) return false;
    current = next;
  }
}

function assertSafeOutput(repoRoot, outDir, inputs) {
  if (outDir === repoRoot || !containsPath(repoRoot, outDir)) {
    throw new Error(
      "unsafe bundle output: must be strictly inside the repository",
    );
  }
  let current = repoRoot;
  for (const segment of path.relative(repoRoot, outDir).split(path.sep)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        "unsafe bundle output: symlink or non-directory component",
      );
    }
  }
  // Resolve existing output parents before comparing input paths.
  const canonicalOut = canonicalPath(outDir);
  if (canonicalOut === repoRoot || !containsPath(repoRoot, canonicalOut)) {
    throw new Error("unsafe bundle output: resolves outside the repository");
  }
  for (const input of inputs) {
    for (const source of [input, canonicalPath(input)]) {
      for (const output of [outDir, canonicalOut]) {
        if (
          containsPath(output, source) ||
          containsPath(source, output) ||
          physicallyContains(output, source) ||
          physicallyContains(source, output)
        ) {
          throw new Error(`unsafe bundle output: overlaps input ${input}`);
        }
      }
    }
  }
}

function withBundleOutput(repoRoot, outDir, inputs, prepare) {
  const marker = `${JSON.stringify({
    tool: "prepare-pi-bundle",
    schemaVersion: 1,
    repoRoot,
    outDir,
  })}\n`;
  const checkOutput = () => {
    assertSafeOutput(repoRoot, outDir, inputs);
    if (!fs.existsSync(outDir)) return;
    const markerPath = path.join(outDir, OWNERSHIP_MARKER);
    const stat = fs.lstatSync(markerPath, { throwIfNoEntry: false });
    if (
      !stat?.isFile() ||
      stat.size !== Buffer.byteLength(marker) ||
      fs.readFileSync(markerPath, "utf8") !== marker
    ) {
      throw new Error(
        "bundle ownership marker missing or invalid; refusing to replace output",
      );
    }
  };
  checkOutput();
  // Serialize cooperating preparations through staging, publication and cleanup.
  const lockDir = path.join(repoRoot, PREPARE_LOCK);
  try {
    fs.mkdirSync(lockDir);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    throw new Error(
      "bundle preparation lock exists; check for an active run before removing it",
    );
  }
  let transaction;
  let result;
  let published = false;
  let preserveRecovery = false;
  const errors = [];
  try {
    checkOutput();
    // Sibling staging keeps both renames on the output's filesystem.
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    transaction = fs.mkdtempSync(
      path.join(path.dirname(outDir), ".gondolin-pi-bundle-"),
    );
    assertSafeOutput(repoRoot, transaction, inputs);
    const candidate = path.join(transaction, "candidate");
    const previous = path.join(transaction, "previous");
    fs.mkdirSync(path.join(candidate, "deps"), { recursive: true });
    fs.writeFileSync(path.join(candidate, OWNERSHIP_MARKER), marker, {
      flag: "wx",
      mode: 0o600,
    });
    result = prepare(candidate);
    checkOutput();
    const hadOutput = fs.existsSync(outDir);
    if (hadOutput) fs.renameSync(outDir, previous);
    try {
      fs.renameSync(candidate, outDir);
    } catch (error) {
      if (hadOutput) {
        try {
          fs.renameSync(previous, outDir);
        } catch (restoreError) {
          // Neither recovery data nor its lock may be removed after failed rollback.
          preserveRecovery = true;
          throw new AggregateError(
            [error, restoreError],
            `could not restore previous bundle at ${previous}; recover it before removing ${lockDir}`,
          );
        }
      }
      throw error;
    }
    published = true;
  } catch (error) {
    errors.push(error);
  }
  if (!preserveRecovery) {
    if (transaction) {
      try {
        fs.rmSync(transaction, { recursive: true, force: true });
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      fs.rmdirSync(lockDir);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    if (published || errors.length > 1) {
      throw new AggregateError(
        errors,
        `${published ? `bundle published at ${outDir}` : "bundle preparation failed"}; cleanup incomplete at ${transaction ?? lockDir}`,
      );
    }
    throw errors[0];
  }
  return result;
}

function sha256File(filePath) {
  return crypto
    .createHash("sha256")
    .update(fs.readFileSync(filePath))
    .digest("hex");
}

function runNpmCi(cwd, target) {
  const args = [
    "ci",
    `--os=${target.os}`,
    `--cpu=${target.cpu}`,
    `--libc=${target.libc}`,
    "--ignore-scripts",
    "--include=prod",
    "--include=dev",
    "--include=optional",
    "--no-audit",
    "--no-fund",
  ];
  const result = spawnSync("npm", args, { cwd, encoding: "utf8" });
  if (result.error) {
    throw new Error(`failed to run npm: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `npm ci failed in ${cwd}: ${result.stderr.trim() || result.stdout.trim()}`,
    );
  }
}

function lockfilePackageCount(lockfilePath) {
  const lock = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  return Object.keys(lock.packages ?? {}).filter(
    (key) => key !== "" && key !== "node_modules",
  ).length;
}

export function platformEntries(lockfilePath, target) {
  const lock = JSON.parse(fs.readFileSync(lockfilePath, "utf8"));
  const entries = [];
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (key === "" || !meta.optional || !Array.isArray(meta.os)) {
      continue;
    }
    if (
      !meta.os.includes(target.os) ||
      !(meta.cpu ?? []).includes(target.cpu)
    ) {
      continue;
    }
    const segments = key.split("/");
    entries.push({
      key,
      meta,
      dir: segments.slice(0, -1).join("/"),
      name: segments[segments.length - 1],
    });
  }
  return entries;
}

// Only musl targets may substitute a native dependency's `-musl` variant for
// its `-gnu` variant in the same directory. Other targets still require their
// matching GNU package even when the lockfile also contains a musl build.
export function assertPlatformTrees(nodeModulesDir, lockfilePath, target) {
  const entries = platformEntries(lockfilePath, target);
  const muslNames = new Set(
    entries
      .filter((entry) => entry.name.endsWith("-musl"))
      .map((entry) => `${entry.dir}/${entry.name}`),
  );

  const missing = [];
  for (const entry of entries) {
    if (
      target.libc === "musl" &&
      entry.name.endsWith("-gnu") &&
      muslNames.has(`${entry.dir}/${entry.name.replace(/-gnu$/, "-musl")}`)
    ) {
      continue;
    }
    if (
      Array.isArray(entry.meta.libc) &&
      !entry.meta.libc.includes(target.libc)
    ) {
      continue;
    }
    const relative = entry.key.replace(/^node_modules\//, "");
    if (!fs.existsSync(path.join(nodeModulesDir, relative))) {
      missing.push(entry.key);
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `baked dependency tree is missing ${target.os}/${target.cpu}/${target.libc} platform packages: ${missing.join(", ")}`,
    );
  }
  return entries.length;
}

function readBuildConfigHome(configPath) {
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const home = config.env?.HOME;
  if (
    typeof home !== "string" ||
    !path.posix.isAbsolute(home) ||
    home.split("/").includes("..")
  ) {
    throw new Error(
      `build config env.HOME must be an absolute guest path without traversal: ${configPath}`,
    );
  }
  // HOME skeletons must not follow symlinks copied from the runtime tree or
  // collide with bundle metadata and other generated copy sources.
  const topLevel = path.posix.normalize(home).split("/")[1];
  if (
    [
      "node_modules",
      "bin",
      "etc",
      "deps",
      "provenance.json",
      OWNERSHIP_MARKER,
    ].includes(topLevel)
  ) {
    throw new Error("build config env.HOME overlaps reserved bundle paths");
  }
  return home;
}

function writeGuestSkeletons(outDir, guestHome) {
  const homeRel = guestHome.replace(/^\//, "");
  fs.mkdirSync(path.join(outDir, homeRel, ".pi", "agent"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "etc"), { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "etc", "gitconfig"),
    "[safe]\n\tdirectory = *\n",
  );
  fs.mkdirSync(path.join(outDir, "bin"), { recursive: true });
}

// The rootfs copy lands the bundle at GUEST_NPM_PREFIX, whose .bin entries are
// relative symlinks. Link absolute targets into a directory on the baked PATH.
function writeBinLinks(outDir, nodeModulesDir) {
  const binDir = path.join(nodeModulesDir, ".bin");
  if (!fs.existsSync(binDir)) {
    throw new Error(`bundle has no node_modules/.bin: ${binDir}`);
  }
  const linksDir = path.join(outDir, "bin");
  const names = fs.readdirSync(binDir);
  if (names.length === 0) {
    throw new Error(`bundle node_modules/.bin is empty: ${binDir}`);
  }
  for (const name of names) {
    const linkPath = path.join(linksDir, name);
    fs.rmSync(linkPath, { force: true, recursive: true });
    fs.symlinkSync(`${GUEST_NPM_PREFIX}/.bin/${name}`, linkPath);
  }
  return names.sort();
}

function isUnsupportedNpmSpec(spec, resolved = false) {
  if (typeof spec !== "string" || !spec.trim()) return false;
  const value = spec.trim();
  if (/^(?:file|git\+file|link|workspace|portal):/i.test(value)) return true;
  if (/^[A-Za-z]:/.test(value)) return true;
  // Require qualified remote specs rather than guessing at slash-containing paths.
  // npm aliases, github: specs, remote URLs and SSH scp addresses remain valid.
  if (
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value) ||
    /^[^\s/@]+@[^\s/:]+:/.test(value)
  ) {
    return false;
  }
  if (resolved) return value !== "registry.npmjs.org";
  return (
    value.startsWith(".") ||
    value.includes("/") ||
    value.includes("\\") ||
    /\.(?:tgz|tar(?:\.gz)?)$/i.test(value)
  );
}

function assertStandaloneNpmInputs(snapshot, label) {
  const manifest = JSON.parse(snapshot.packageJson.toString("utf8"));
  const lock = JSON.parse(snapshot.lockfile.toString("utf8"));
  const reject = () => {
    throw new Error(
      `${label}: unsupported workspace or path-like dependency; use standalone npm inputs and qualified remote specs`,
    );
  };
  for (const value of [manifest, lock]) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label}: invalid npm manifest or lockfile`);
    }
  }
  if (Object.hasOwn(manifest, "workspaces")) reject();
  const fields = [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ];
  const specs = [
    ...fields.map((field) => ({ value: manifest[field], override: false })),
    { value: manifest.overrides, override: true },
  ];
  while (specs.length) {
    const { value, override } = specs.pop();
    if (typeof value === "string") {
      if (override && value.startsWith("$")) {
        // References inherit a declared dependency's independently checked spec.
        const name = value.slice(1);
        if (
          !fields.some((field) => Object.hasOwn(manifest[field] ?? {}, name))
        ) {
          reject();
        }
      } else if (isUnsupportedNpmSpec(value)) {
        reject();
      }
    } else if (value && typeof value === "object") {
      specs.push(...Object.values(value).map((value) => ({ value, override })));
    }
  }
  const entries = [
    ...Object.values(lock.packages ?? {}),
    ...Object.values(lock.dependencies ?? {}),
  ];
  while (entries.length) {
    const entry = entries.pop();
    if (!entry || typeof entry !== "object") continue;
    if (entry.link === true || Object.hasOwn(entry, "workspaces")) reject();
    if (
      isUnsupportedNpmSpec(entry.version) ||
      isUnsupportedNpmSpec(entry.resolved, true)
    ) {
      reject();
    }
    for (const field of [...fields, "requires"]) {
      for (const spec of Object.values(entry[field] ?? {})) {
        if (isUnsupportedNpmSpec(spec)) reject();
      }
    }
    // v1 lockfiles nest dependency descriptors instead of a flat packages map.
    entries.push(...Object.values(entry.dependencies ?? {}));
  }
}

function readNpmSnapshot(dir, label) {
  const snapshot = {};
  for (const [field, name] of [
    ["packageJson", "package.json"],
    ["lockfile", "package-lock.json"],
  ]) {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error(`${label}: missing ${file}`);
    snapshot[field] = fs.readFileSync(file);
  }
  assertStandaloneNpmInputs(snapshot, label);
  return snapshot;
}

function installRuntimeBundle(snapshot, target, outDir, guestHome) {
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-pi-bundle-"));
  try {
    const stagedManifest = path.join(stage, "package.json");
    const stagedLockfile = path.join(stage, "package-lock.json");
    fs.writeFileSync(stagedManifest, snapshot.packageJson);
    fs.writeFileSync(stagedLockfile, snapshot.lockfile);
    const manifest = JSON.parse(fs.readFileSync(stagedManifest, "utf8"));
    const packageName = Object.keys(manifest.dependencies ?? {})[0];
    if (!packageName) {
      throw new Error("bundle manifest declares no dependency");
    }
    const lockfileSha256 = sha256File(stagedLockfile);
    runNpmCi(stage, target);
    const installed = path.join(stage, "node_modules");
    if (!fs.existsSync(installed)) {
      throw new Error(`npm ci produced no node_modules in ${stage}`);
    }
    assertPlatformTrees(installed, stagedLockfile, target);
    fs.cpSync(installed, path.join(outDir, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    writeGuestSkeletons(outDir, guestHome);
    const binLinks = writeBinLinks(outDir, path.join(outDir, "node_modules"));
    return {
      package: packageName,
      version: manifest.dependencies[packageName],
      lockfileSha256,
      binLinks,
    };
  } finally {
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function parseDepSpecs(specs) {
  const repos = [];
  const keys = new Set();
  for (const spec of specs) {
    const eq = spec.indexOf("=");
    if (eq <= 0 || eq === spec.length - 1) {
      throw new Error(`--deps expects <key>=<repo-dir>, got: ${spec}`);
    }
    const key = spec.slice(0, eq);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
      throw new Error(`invalid repo key: ${key}`);
    }
    // ASCII keys must remain unambiguous on case-insensitive build hosts too.
    const identity = key.toLowerCase();
    if (keys.has(identity)) throw new Error(`duplicate repo key: ${key}`);
    keys.add(identity);
    repos.push({ key, dir: path.resolve(spec.slice(eq + 1)) });
  }
  return repos;
}

function bakeRepoDeps(outDir, repos, target) {
  const baked = [];
  for (const repo of repos) {
    const stage = fs.mkdtempSync(
      path.join(os.tmpdir(), `gondolin-deps-${repo.key}-`),
    );
    try {
      const stagedLockfile = path.join(stage, "package-lock.json");
      fs.writeFileSync(
        path.join(stage, "package.json"),
        repo.snapshot.packageJson,
      );
      fs.writeFileSync(stagedLockfile, repo.snapshot.lockfile);
      runNpmCi(stage, target);
      const installed = path.join(stage, "node_modules");
      const platformCount = assertPlatformTrees(
        installed,
        stagedLockfile,
        target,
      );
      // Successful npm ci may omit node_modules when there is nothing to install.
      fs.mkdirSync(installed, { recursive: true });
      const dest = path.join(outDir, "deps", repo.key);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(installed, path.join(dest, "node_modules"), {
        recursive: true,
        verbatimSymlinks: true,
      });
      baked.push({
        repoKey: repo.key,
        lockfileSha256: sha256File(stagedLockfile),
        packageCount: lockfilePackageCount(stagedLockfile),
        platformPackages: platformCount,
      });
    } finally {
      fs.rmSync(stage, { recursive: true, force: true });
    }
  }
  return baked;
}

export function preparePiBundle(options) {
  const repoRoot = fs.realpathSync(options.repoRoot ?? process.cwd());
  const configPath = path.resolve(repoRoot, requireArg(options, "config"));
  const outDir = path.resolve(repoRoot, options.out ?? DEFAULT_OUT_DIR);
  const target = {
    os: options.os ?? DEFAULT_TARGET.os,
    cpu: options.cpu ?? DEFAULT_TARGET.cpu,
    libc: options.libc ?? DEFAULT_TARGET.libc,
  };
  const repos = options.noDeps ? [] : parseDepSpecs(options.deps ?? []);

  const guestHome = readBuildConfigHome(configPath);
  const inputs = [
    configPath,
    ...[
      path.join(repoRoot, BUNDLE_PACKAGE_DIR),
      ...repos.map((repo) => repo.dir),
    ].flatMap((dir) => [
      dir,
      path.join(dir, "package.json"),
      path.join(dir, "package-lock.json"),
    ]),
    path.join(repoRoot, ".git"),
    path.join(repoRoot, PREPARE_LOCK),
  ];
  // Freeze and validate every input before an existing owned bundle is replaced.
  const runtime = readNpmSnapshot(
    path.join(repoRoot, BUNDLE_PACKAGE_DIR),
    "Pi runtime bundle",
  );
  const repoSnapshots = repos.map((repo) => ({
    ...repo,
    snapshot: readNpmSnapshot(repo.dir, `repo ${repo.key}`),
  }));
  return withBundleOutput(repoRoot, outDir, inputs, (candidate) => {
    const piBundle = installRuntimeBundle(
      runtime,
      target,
      candidate,
      guestHome,
    );
    const bakedRepos = bakeRepoDeps(candidate, repoSnapshots, target);
    const provenance = {
      schemaVersion: 1,
      target,
      preparedAt: new Date().toISOString(),
      guestHome,
      piBundle,
      bakedRepos,
      gitSafeDirectory: "*",
      expectedToolchain: EXPECTED_TOOLCHAIN,
    };
    fs.writeFileSync(
      path.join(candidate, "provenance.json"),
      `${JSON.stringify(provenance, null, 2)}\n`,
    );
    return { outDir, provenance };
  });
}

function main(argv) {
  const { values: args } = parseArgs({
    args: argv,
    options: {
      config: { type: "string" },
      out: { type: "string" },
      deps: { type: "string", multiple: true },
      os: { type: "string" },
      cpu: { type: "string" },
      libc: { type: "string" },
      "no-deps": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
  });
  if (args.help) {
    console.log(usage());
    return;
  }
  const options = { ...args, noDeps: args["no-deps"] };
  const { outDir, provenance } = preparePiBundle(options);
  console.log(`bundle written to ${outDir}`);
  console.log(
    `pi bundle: ${provenance.piBundle.package}@${provenance.piBundle.version}`,
  );
  for (const repo of provenance.bakedRepos) {
    console.log(
      `baked ${repo.repoKey}: ${repo.packageCount} packages, lockfile ${repo.lockfileSha256.slice(0, 12)}`,
    );
  }
  console.log(
    "next: gondolin build --config <config> --tag pi-node-base:<tag>",
  );
}

// Node resolves the entry module physically (e.g. /var -> /private/var on macOS).
if (
  process.argv[1] &&
  fs.existsSync(process.argv[1]) &&
  import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href
) {
  main(process.argv.slice(2));
}
