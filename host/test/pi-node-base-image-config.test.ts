import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseBuildConfig, validateBuildConfig } from "../src/build/config.ts";

const configPath = path.resolve(
  import.meta.dirname,
  "../../images/pi-node-base.json",
);

function loadConfig(text: string): Record<string, unknown> {
  return JSON.parse(text) as Record<string, unknown>;
}

function copyDestinations(config: Record<string, unknown>): Set<string> {
  const postBuild = config.postBuild as {
    copy?: { dest: string }[];
  };
  return new Set((postBuild.copy ?? []).map((entry) => entry.dest));
}

function copyEntries(
  config: Record<string, unknown>,
  dest: string,
): { src: string; dest: string }[] {
  const postBuild = config.postBuild as {
    copy?: { src: string; dest: string }[];
  };
  return (postBuild.copy ?? []).filter((entry) => entry.dest === dest);
}

test("pi-node-base: build config parses and validates", () => {
  const text = fs.readFileSync(configPath, "utf8");
  const config = loadConfig(text);

  assert.equal(validateBuildConfig(config), true);

  const parsed = parseBuildConfig(text);
  assert.equal(parsed.arch, "aarch64");
  assert.equal(parsed.distro, "alpine");
});

function imageReleaseJob(): string {
  const workflow = fs.readFileSync(
    new URL("../../.github/workflows/image-release.yml", import.meta.url),
    "utf8",
  );
  const job = workflow
    .split("\n  build-image:\n")[1]
    ?.split("\n  publish-image-release:\n")[0];
  assert.ok(job, "missing build-image job");
  return job;
}

test("pi-node-base: image release maps guest architectures to npm CPUs", () => {
  const entries = [
    ...imageReleaseJob().matchAll(
      / {10}- arch: (\w+)\n([\s\S]*?)(?= {10}- arch:| {4}steps:)/g,
    ),
  ];
  assert.deepEqual(
    entries.map((entry) => [entry[1], entry[2].match(/npm_cpu: (\w+)/)?.[1]]),
    [
      ["aarch64", "arm64"],
      ["x86_64", "x64"],
    ],
  );
});

test("pi-node-base: image release prepares the runtime bundle before building", () => {
  const job = imageReleaseJob();
  const install = job.indexOf("      - name: Install dependencies\n");
  const prepare = job.indexOf("      - name: Prepare Pi bundle\n");
  const build = job.indexOf("      - name: Build guest image\n");
  assert.ok(install >= 0 && prepare > install && build > prepare);
  const step = job.slice(prepare, job.indexOf("\n      -", prepare + 1));
  for (const token of [
    "if: needs.prepare.outputs.build_config == 'images/pi-node-base.json'",
    "BUILD_CONFIG: ${{ needs.prepare.outputs.build_config }}",
    "TARGET_CPU: ${{ matrix.npm_cpu }}",
    "node scripts/prepare-pi-bundle.mjs",
    '--config "$BUILD_CONFIG"',
    '--cpu "$TARGET_CPU"',
    "--os linux",
    "--libc musl",
    "--no-deps",
  ]) {
    assert.ok(
      step.includes(token),
      `missing release preparation contract: ${token}`,
    );
  }
});

test("pi-node-base: image name is valid for the image release workflow", () => {
  const config = loadConfig(fs.readFileSync(configPath, "utf8"));

  assert.equal(
    typeof config.imageName === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.imageName),
    true,
  );
});

test("pi-node-base: pins the alpine release, kernel package, and krunfw version", () => {
  const config = loadConfig(fs.readFileSync(configPath, "utf8"));
  const alpine = config.alpine as Record<string, unknown>;

  assert.equal(typeof alpine.version, "string");
  assert.match(String(alpine.version), /^\d+\.\d+\.\d+$/);
  assert.equal(typeof alpine.kernelPackage, "string");
  assert.equal(typeof alpine.kernelImage, "string");
  // An unpinned krunfw version makes the kernel leg non-reproducible.
  assert.match(String(alpine.krunfwVersion), /^v\d+\.\d+\.\d+$/);
});

test("pi-node-base: bakes HOME and a PATH that includes /usr/local/bin", () => {
  const config = loadConfig(fs.readFileSync(configPath, "utf8"));
  const env = config.env as Record<string, string>;

  // The guest expects HOME to exist; without it `pi` cannot write state and git
  // cannot resolve a global config path.
  assert.equal(env.HOME, "/pi-scratch");

  // The default Alpine PATH omits /usr/local/bin, so baked bin links there are
  // invisible unless the image bakes PATH as well.
  const pathDirs = (env.PATH ?? "").split(":");
  assert.ok(pathDirs.includes("/usr/local/bin"));
});

test("pi-node-base: copies the node module bundle, bin links, git config, and HOME skeleton", () => {
  const config = loadConfig(fs.readFileSync(configPath, "utf8"));
  const destinations = copyDestinations(config);

  for (const dest of [
    "/usr/local/lib/node_modules/",
    "/usr/local/bin/",
    "/etc/",
    "/pi-scratch/",
  ]) {
    assert.ok(destinations.has(dest), `missing postBuild.copy dest: ${dest}`);
  }

  // Bin links must be baked as copies: postBuild.commands needs a Linux chroot
  // and cannot run on a macOS host.
  const postBuild = config.postBuild as { commands?: string[] };
  assert.equal(postBuild.commands === undefined, true);
});

test("pi-node-base: copy sources are bundle-relative, not host-specific paths", () => {
  const config = loadConfig(fs.readFileSync(configPath, "utf8"));
  const postBuild = config.postBuild as { copy: { src: string }[] };

  // Absolute sources bake one operator's host layout into a shared image config
  // and make the build non-reproducible for everyone else.
  for (const entry of postBuild.copy) {
    assert.ok(
      !entry.src.startsWith("/") &&
        !entry.src.includes("..") &&
        entry.src.startsWith("pi-bundle/"),
      `postBuild.copy source must be bundle-relative: ${entry.src}`,
    );
  }
});

test("pi-node-base: bakes dependency state and provenance for zero-install validation", () => {
  const config = loadConfig(fs.readFileSync(configPath, "utf8"));
  const destinations = copyDestinations(config);

  assert.ok(destinations.has("/pi-deps/"));
  assert.ok(destinations.has("/etc/pi-image-provenance.json"));

  // Provenance is a single file copy, not a directory, so the guest can read a
  // stable path without guessing bundle layout.
  const provenanceEntries = copyEntries(
    config,
    "/etc/pi-image-provenance.json",
  );
  assert.equal(provenanceEntries.length, 1);
  assert.ok(!provenanceEntries[0].src.endsWith("/"));
});

test("pi-node-base: Alpine version tracks the registry base image", () => {
  // The prepared-bundle image must not drift behind the distro version the repo
  // itself builds, otherwise security bumps silently skip this image.
  const base = loadConfig(
    fs.readFileSync(
      path.resolve(import.meta.dirname, "../../images/alpine-base.json"),
      "utf8",
    ),
  ) as { alpine: { version: string; rootfsPackages: string[] } };
  const config = loadConfig(fs.readFileSync(configPath, "utf8")) as {
    alpine: { version: string; rootfsPackages: string[] };
  };

  assert.equal(
    config.alpine.version,
    base.alpine.version,
    "pi-node-base Alpine version must match images/alpine-base.json",
  );
  for (const pkg of ["ca-certificates", "ca-certificates-bundle"]) {
    assert.ok(
      config.alpine.rootfsPackages.includes(pkg),
      `${pkg} is required for egress TLS validation`,
    );
  }
});
