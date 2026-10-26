import assert from "node:assert/strict";
import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";

import {
  assertPlatformTrees,
  parseDepSpecs,
  platformEntries,
  preparePiBundle,
  // biome-ignore lint/correctness/useImportExtensions: Biome resolves .d.mts and suggests .mjs.mts; Node requires the runtime .mjs
} from "../../scripts/prepare-pi-bundle.mjs";

const MUSL_TARGET = { os: "linux", cpu: "arm64", libc: "musl" };
const SCRIPT = new URL("../../scripts/prepare-pi-bundle.mjs", import.meta.url);
const IMAGE_CONFIG = new URL("../../images/pi-node-base.json", import.meta.url);
const NPM_ARGS = [
  "ci",
  "--os=linux",
  "--cpu=arm64",
  "--libc=musl",
  "--ignore-scripts",
  "--include=prod",
  "--include=dev",
  "--include=optional",
  "--no-audit",
  "--no-fund",
];

function bundleFixture(t: TestContext) {
  const envelope = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bundle-repo-"));
  t.after(() => fs.rmSync(envelope, { recursive: true, force: true }));
  const root = path.join(envelope, "checkout");
  const config = path.join(root, "images", "pi-node-base.json");
  const runtime = path.join(root, "images", "pi-node-base.bundle");
  const repo = path.join(root, "repo");
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(repo);
  fs.copyFileSync(IMAGE_CONFIG, config);
  for (const [dir, name] of [
    [runtime, "runtime-fixture"],
    [repo, "repo-fixture"],
  ]) {
    fs.writeFileSync(
      path.join(dir, "package.json"),
      JSON.stringify({ name, dependencies: { [name]: "1.2.3" } }),
    );
    fs.writeFileSync(
      path.join(dir, "package-lock.json"),
      JSON.stringify({ name, lockfileVersion: 3, packages: {} }),
    );
  }
  return { root, config, runtime, repo };
}

function mockNpm(
  t: TestContext,
  onInstall?: (
    cwd: string,
    index: number,
  ) => { status: number; stderr: string } | undefined,
) {
  const calls: Array<{ cwd: string; manifest: string; lockfile: string }> = [];
  const mock = t.mock.method(
    childProcess,
    "spawnSync",
    (
      command: string,
      args: string[],
      options: { cwd: string; encoding: string },
    ) => {
      assert.equal(command, "npm");
      assert.deepEqual(args, NPM_ARGS);
      const { cwd } = options;
      assert.deepEqual(options, { cwd, encoding: "utf8" });
      assert.equal(path.dirname(cwd), path.resolve(os.tmpdir()));
      assert.ok(path.basename(cwd).startsWith("gondolin-"));
      t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
      calls.push({
        cwd,
        manifest: fs.readFileSync(path.join(cwd, "package.json"), "utf8"),
        lockfile: fs.readFileSync(path.join(cwd, "package-lock.json"), "utf8"),
      });
      const bins = path.join(cwd, "node_modules", ".bin");
      fs.mkdirSync(bins, { recursive: true });
      fs.writeFileSync(path.join(bins, "pi"), "fixture");
      return {
        status: 0,
        stdout: "",
        stderr: "",
        pid: 1,
        signal: null,
        output: [],
        ...onInstall?.(cwd, calls.length - 1),
      };
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    mock.mock.restore();
    syncBuiltinESMExports();
  });
  return calls;
}

for (const argv of [
  ["--no-deps", "--help"],
  ["--help", "--no-deps"],
]) {
  test(`prepare-pi-bundle: CLI accepts ${argv.join(" ")}`, () => {
    const result = childProcess.spawnSync(
      process.execPath,
      [SCRIPT.pathname, ...argv],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Usage:.*prepare-pi-bundle/);
  });
}

for (const position of ["before", "after"]) {
  test(`prepare-pi-bundle: CLI --no-deps ${position} value flags skips repo installs`, (t) => {
    const fixture = bundleFixture(t);
    const bin = path.join(fixture.root, "bin");
    const log = path.join(fixture.root, "npm-calls.jsonl");
    fs.mkdirSync(bin);
    // A local npm stand-in keeps this full CLI test offline and deterministic.
    fs.writeFileSync(
      path.join(bin, "npm"),
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  manifest: JSON.parse(fs.readFileSync("package.json", "utf8")),
}) + "\\n");
fs.mkdirSync("node_modules/.bin", { recursive: true });
fs.writeFileSync("node_modules/.bin/pi", "fixture");
`,
      { mode: 0o755 },
    );
    const args = [
      "--config",
      "images/pi-node-base.json",
      "--deps",
      "ignored=missing-repo",
      "--deps=also-ignored=another-missing-repo",
      "--deps=self=.",
    ];
    if (position === "before") args.unshift("--no-deps");
    else args.push("--no-deps");
    const result = childProcess.spawnSync(
      process.execPath,
      [SCRIPT.pathname, ...args],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          npm_config_omit: "prod dev optional",
          PATH: [bin, path.dirname(process.execPath), process.env.PATH].join(
            path.delimiter,
          ),
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    const calls = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, NPM_ARGS);
    assert.equal(calls[0].manifest.name, "runtime-fixture");
    assert.notEqual(calls[0].cwd, fixture.runtime);
    const outDir = path.join(fixture.root, "images", "pi-bundle");
    const provenance = JSON.parse(
      fs.readFileSync(path.join(outDir, "provenance.json"), "utf8"),
    );
    assert.deepEqual(provenance.bakedRepos, []);
    assert.deepEqual(fs.readdirSync(path.join(outDir, "deps")), []);
  });
}

for (const noDeps of [false, true]) {
  test(`prepare-pi-bundle: runtime-only copy sources exist (noDeps=${noDeps})`, (t) => {
    const fixture = bundleFixture(t);
    const calls = mockNpm(t);
    const { outDir, provenance } = preparePiBundle({
      repoRoot: fixture.root,
      config: "images/pi-node-base.json",
      noDeps,
      deps: noDeps
        ? [`ignored=${path.join(fixture.root, "missing-repo")}`]
        : [],
    });
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].manifest,
      fs.readFileSync(path.join(fixture.runtime, "package.json"), "utf8"),
    );
    assert.equal(
      calls[0].lockfile,
      fs.readFileSync(path.join(fixture.runtime, "package-lock.json"), "utf8"),
    );
    assert.equal(provenance.piBundle.package, "runtime-fixture");
    assert.equal(provenance.piBundle.version, "1.2.3");
    assert.equal(
      provenance.piBundle.lockfileSha256,
      crypto.createHash("sha256").update(calls[0].lockfile).digest("hex"),
    );
    assert.deepEqual(provenance.bakedRepos, []);
    assert.deepEqual(fs.readdirSync(path.join(outDir, "deps")), []);
    const config = JSON.parse(fs.readFileSync(fixture.config, "utf8"));
    for (const copy of config.postBuild.copy) {
      assert.ok(
        fs.existsSync(path.resolve(path.dirname(fixture.config), copy.src)),
        `missing copy source: ${copy.src}`,
      );
    }
  });
}

test("prepare-pi-bundle: runtime and repo installs use isolated stages and safe npm flags", (t) => {
  const fixture = bundleFixture(t);
  const calls = mockNpm(t);
  const { outDir, provenance } = preparePiBundle({
    repoRoot: fixture.root,
    config: "images/pi-node-base.json",
    deps: [`fixture=${fixture.repo}`],
  });
  assert.equal(calls.length, 2);
  assert.notEqual(calls[0].cwd, calls[1].cwd);
  for (const [index, source] of [fixture.runtime, fixture.repo].entries()) {
    const call = calls[index];
    assert.notEqual(call.cwd, source);
    assert.ok(
      path
        .basename(call.cwd)
        .startsWith(
          index === 0 ? "gondolin-pi-bundle-" : "gondolin-deps-fixture-",
        ),
    );
    assert.equal(
      call.manifest,
      fs.readFileSync(path.join(source, "package.json"), "utf8"),
    );
    assert.equal(
      call.lockfile,
      fs.readFileSync(path.join(source, "package-lock.json"), "utf8"),
    );
    assert.ok(!fs.existsSync(path.join(source, "node_modules")));
    assert.ok(!fs.existsSync(call.cwd), "successful stages are cleaned up");
  }
  assert.ok(
    fs.existsSync(path.join(outDir, "deps", "fixture", "node_modules")),
  );
  assert.equal(provenance.bakedRepos[0].repoKey, "fixture");
});

for (const out of [
  ".",
  "..",
  "../outside",
  "images",
  "images/pi-node-base.json",
  "images/pi-node-base.bundle",
  "images/pi-node-base.bundle/nested",
  "repo",
  "repo/nested",
]) {
  test(`prepare-pi-bundle: rejects unsafe output ${out} without touching inputs`, (t) => {
    const fixture = bundleFixture(t);
    const calls = mockNpm(t);
    const sentinel = path.join(fixture.root, "keep.txt");
    fs.writeFileSync(sentinel, "keep");
    assert.throws(
      () =>
        preparePiBundle({
          repoRoot: fixture.root,
          config: "images/pi-node-base.json",
          out,
          deps: [`fixture=${fixture.repo}`],
        }),
      /unsafe bundle output/,
    );
    assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
    assert.ok(fs.existsSync(fixture.config));
    assert.ok(fs.existsSync(path.join(fixture.runtime, "package.json")));
    assert.ok(fs.existsSync(path.join(fixture.repo, "package.json")));
    assert.equal(calls.length, 0);
  });
}

test("prepare-pi-bundle: case aliases cannot bypass input overlap checks", (t) => {
  const fixture = bundleFixture(t);
  if (!fs.existsSync(path.join(fixture.root, "IMAGES"))) {
    t.skip("requires a case-insensitive filesystem");
    return;
  }
  const calls = mockNpm(t);
  assert.throws(
    () =>
      preparePiBundle({
        repoRoot: fixture.root,
        config: "images/pi-node-base.json",
        out: "IMAGES/pi-node-base.bundle/nested",
      }),
    /unsafe bundle output.*overlap/,
  );
  assert.ok(!fs.existsSync(path.join(fixture.runtime, "nested")));
  assert.ok(fs.existsSync(path.join(fixture.runtime, "package.json")));
  assert.equal(calls.length, 0);
});

for (const leaf of [true, false]) {
  test(`prepare-pi-bundle: rejects symlinked output components (leaf=${leaf})`, (t) => {
    const fixture = bundleFixture(t);
    const calls = mockNpm(t);
    const outside = path.join(path.dirname(fixture.root), "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
    fs.symlinkSync(outside, path.join(fixture.root, "linked"));
    assert.throws(
      () =>
        preparePiBundle({
          repoRoot: fixture.root,
          config: "images/pi-node-base.json",
          out: leaf ? "linked" : "linked/nested",
        }),
      /unsafe bundle output/,
    );
    assert.equal(
      fs.readFileSync(path.join(outside, "keep.txt"), "utf8"),
      "keep",
    );
    assert.deepEqual(fs.readdirSync(outside), ["keep.txt"]);
    assert.ok(fs.lstatSync(path.join(fixture.root, "linked")).isSymbolicLink());
    assert.equal(calls.length, 0);
  });
}

test("prepare-pi-bundle: input symlinks into the output are protected", (t) => {
  const fixture = bundleFixture(t);
  const calls = mockNpm(t);
  const output = path.join(fixture.root, "images", "pi-bundle");
  fs.mkdirSync(output);
  fs.renameSync(fixture.repo, path.join(output, "source-repo"));
  fs.symlinkSync(path.join(output, "source-repo"), fixture.repo);
  assert.throws(
    () =>
      preparePiBundle({
        repoRoot: fixture.root,
        config: "images/pi-node-base.json",
        deps: [`fixture=${fixture.repo}`],
      }),
    /unsafe bundle output.*overlap/,
  );
  assert.ok(fs.existsSync(path.join(fixture.repo, "package.json")));
  assert.equal(calls.length, 0);
});

for (const marker of [undefined, "invalid", "symlink"]) {
  test(`prepare-pi-bundle: existing output needs ownership (marker=${marker})`, (t) => {
    const fixture = bundleFixture(t);
    const calls = mockNpm(t);
    const output = path.join(fixture.root, "images", "pi-bundle");
    const sentinel = path.join(output, "keep.txt");
    fs.mkdirSync(output);
    fs.writeFileSync(sentinel, "keep");
    const markerPath = path.join(output, ".gondolin-pi-bundle");
    if (marker === "invalid") fs.writeFileSync(markerPath, "invalid");
    if (marker === "symlink") fs.symlinkSync(sentinel, markerPath);
    assert.throws(
      () =>
        preparePiBundle({
          repoRoot: fixture.root,
          config: "images/pi-node-base.json",
        }),
      /bundle ownership marker/,
    );
    assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
    assert.equal(calls.length, 0);
  });
}

test("prepare-pi-bundle: owned output can be rebuilt", (t) => {
  const fixture = bundleFixture(t);
  const calls = mockNpm(t);
  const options = {
    repoRoot: fixture.root,
    config: "images/pi-node-base.json",
  };
  const { outDir } = preparePiBundle(options);
  const markerPath = path.join(outDir, ".gondolin-pi-bundle");
  const marker = fs.readFileSync(markerPath, "utf8");
  const stale = path.join(outDir, "stale.txt");
  fs.writeFileSync(stale, "stale");
  preparePiBundle(options);
  assert.equal(calls.length, 2);
  assert.ok(!fs.existsSync(stale));
  assert.equal(fs.readFileSync(markerPath, "utf8"), marker);
  assert.ok(fs.existsSync(path.join(outDir, "provenance.json")));
});

test("prepare-pi-bundle: an active preparation lock preserves existing output", (t) => {
  const fixture = bundleFixture(t);
  const calls = mockNpm(t);
  const options = {
    repoRoot: fixture.root,
    config: "images/pi-node-base.json",
  };
  const { outDir } = preparePiBundle(options);
  const before = fs.readFileSync(path.join(outDir, "provenance.json"), "utf8");
  const lock = path.join(fixture.root, ".gondolin-pi-bundle.lock");
  fs.mkdirSync(lock);
  assert.throws(() => preparePiBundle(options), /preparation lock exists/);
  assert.equal(calls.length, 1);
  assert.equal(
    fs.readFileSync(path.join(outDir, "provenance.json"), "utf8"),
    before,
  );
  assert.ok(fs.existsSync(lock), "another run's lock must not be removed");
});

for (const home of [
  "/../escape",
  "/pi-scratch/../../escape",
  "/node_modules/.bin",
  "/./bin",
  "/etc",
  "/deps",
  "/provenance.json",
  "/.gondolin-pi-bundle",
]) {
  test(`prepare-pi-bundle: rejects unsafe HOME ${home} before preparing output`, (t) => {
    const fixture = bundleFixture(t);
    const calls = mockNpm(t);
    const config = JSON.parse(fs.readFileSync(fixture.config, "utf8"));
    config.env.HOME = home;
    fs.writeFileSync(fixture.config, JSON.stringify(config));
    assert.throws(
      () =>
        preparePiBundle({
          repoRoot: fixture.root,
          config: "images/pi-node-base.json",
        }),
      /env.HOME/,
    );
    assert.equal(calls.length, 0);
    assert.ok(!fs.existsSync(path.join(fixture.root, "images", "pi-bundle")));
    assert.ok(!fs.existsSync(path.join(fixture.root, "escape")));
  });
}

for (const stageIndex of [0, 1]) {
  test(`prepare-pi-bundle: cleans stage ${stageIndex} if manifest staging fails`, (t) => {
    const fixture = bundleFixture(t);
    mockNpm(t);
    const stages: string[] = [];
    const mkdtemp = fs.mkdtempSync;
    t.mock.method(fs, "mkdtempSync", (prefix: string) => {
      const stage = mkdtemp(prefix);
      assert.equal(path.dirname(stage), path.resolve(os.tmpdir()));
      assert.ok(path.basename(stage).startsWith("gondolin-"));
      stages.push(stage);
      t.after(() => fs.rmSync(stage, { recursive: true, force: true }));
      return stage;
    });
    const write = fs.writeFileSync;
    t.mock.method(
      fs,
      "writeFileSync",
      (...args: Parameters<typeof fs.writeFileSync>) => {
        const stage = stages[stageIndex];
        if (stage && args[0] === path.join(stage, "package-lock.json")) {
          throw new Error("fixture manifest copy failure");
        }
        return write(...args);
      },
    );
    assert.throws(
      () =>
        preparePiBundle({
          repoRoot: fixture.root,
          config: "images/pi-node-base.json",
          deps: [`fixture=${fixture.repo}`],
        }),
      /fixture manifest copy failure/,
    );
    assert.equal(stages.length, stageIndex + 1);
    for (const stage of stages) assert.ok(!fs.existsSync(stage));
    assert.ok(
      !fs.existsSync(path.join(fixture.root, ".gondolin-pi-bundle.lock")),
    );
  });
}

for (const stageIndex of [0, 1]) {
  for (const failure of ["npm", "platform", "copy", "bin"]) {
    if (stageIndex === 1 && failure === "bin") continue;
    test(`prepare-pi-bundle: cleans stage ${stageIndex} after ${failure} failure`, (t) => {
      const fixture = bundleFixture(t);
      const calls = mockNpm(t, (_cwd, index) => {
        if (index === stageIndex && failure === "npm") {
          return { status: 1, stderr: "fixture npm failure" };
        }
        if (index === stageIndex && failure === "bin") {
          fs.rmSync(path.join(_cwd, "node_modules", ".bin"), {
            recursive: true,
          });
        }
        return undefined;
      });
      if (failure === "platform") {
        const source = stageIndex === 0 ? fixture.runtime : fixture.repo;
        fs.writeFileSync(
          path.join(source, "package-lock.json"),
          JSON.stringify({
            packages: {
              "node_modules/missing-linux-arm64-musl": {
                optional: true,
                os: ["linux"],
                cpu: ["arm64"],
                libc: ["musl"],
              },
            },
          }),
        );
      }
      if (failure === "copy") {
        const copy = fs.cpSync;
        t.mock.method(fs, "cpSync", (...args: Parameters<typeof fs.cpSync>) => {
          const cwd = calls[stageIndex]?.cwd;
          if (cwd && args[0] === path.join(cwd, "node_modules")) {
            throw new Error("fixture copy failure");
          }
          return copy(...args);
        });
      }
      assert.throws(
        () =>
          preparePiBundle({
            repoRoot: fixture.root,
            config: "images/pi-node-base.json",
            deps: [`fixture=${fixture.repo}`],
          }),
        /fixture npm failure|missing linux\/arm64\/musl|fixture copy failure|no node_modules\/\.bin/,
      );
      assert.equal(calls.length, stageIndex + 1);
      for (const call of calls) {
        assert.ok(!fs.existsSync(call.cwd), `leaked stage: ${call.cwd}`);
      }
      assert.ok(
        !fs.existsSync(path.join(fixture.root, ".gondolin-pi-bundle.lock")),
      );
    });
  }
}

function writeFixture(t: TestContext, lock: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "prepare-pi-bundle-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(root, "package-lock.json"),
    `${JSON.stringify(lock, null, 2)}\n`,
  );
  return root;
}

function install(root: string, relative: string): void {
  const target = path.join(root, "node_modules", relative);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "package.json"), "{}\n");
}

test("prepare-pi-bundle: musl variant replaces the gnu variant", (t: TestContext) => {
  const root = writeFixture(t, {
    packages: {
      "": { name: "fixture" },
      "node_modules/@rollup/rollup-linux-arm64-gnu": {
        version: "1.0.0",
        optional: true,
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["gnu"],
      },
      "node_modules/@rollup/rollup-linux-arm64-musl": {
        version: "1.0.0",
        optional: true,
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["musl"],
      },
    },
  });
  install(root, "@rollup/rollup-linux-arm64-musl");

  const count = assertPlatformTrees(
    path.join(root, "node_modules"),
    path.join(root, "package-lock.json"),
    MUSL_TARGET,
  );
  assert.equal(count, 2);
});

test("prepare-pi-bundle: glibc targets require the gnu variant even when musl exists", (t: TestContext) => {
  const root = writeFixture(t, {
    packages: {
      "node_modules/@rollup/rollup-linux-arm64-gnu": {
        version: "1.0.0",
        optional: true,
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["glibc"],
      },
      "node_modules/@rollup/rollup-linux-arm64-musl": {
        version: "1.0.0",
        optional: true,
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["musl"],
      },
    },
  });
  install(root, "@rollup/rollup-linux-arm64-musl");
  const args = [
    path.join(root, "node_modules"),
    path.join(root, "package-lock.json"),
    { ...MUSL_TARGET, libc: "glibc" },
  ] as const;
  assert.throws(
    () => assertPlatformTrees(...args),
    /missing linux\/arm64\/glibc platform packages: node_modules\/@rollup\/rollup-linux-arm64-gnu/,
  );
  install(root, "@rollup/rollup-linux-arm64-gnu");
  assert.equal(assertPlatformTrees(...args), 2);
});

test("prepare-pi-bundle: a missing musl package fails closed", (t: TestContext) => {
  const root = writeFixture(t, {
    packages: {
      "": { name: "fixture" },
      "node_modules/@rollup/rollup-linux-arm64-musl": {
        version: "1.0.0",
        optional: true,
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["musl"],
      },
    },
  });

  assert.throws(
    () =>
      assertPlatformTrees(
        path.join(root, "node_modules"),
        path.join(root, "package-lock.json"),
        MUSL_TARGET,
      ),
    /missing linux\/arm64\/musl platform packages: node_modules\/@rollup\/rollup-linux-arm64-musl/,
  );
});

test("prepare-pi-bundle: nested platform packages are checked in place", (t: TestContext) => {
  const root = writeFixture(t, {
    packages: {
      "": { name: "fixture" },
      "node_modules/pi/node_modules/@mariozechner/clipboard-linux-arm64-gnu": {
        version: "1.0.0",
        optional: true,
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["gnu"],
      },
      "node_modules/pi/node_modules/@mariozechner/clipboard-linux-arm64-musl": {
        version: "1.0.0",
        optional: true,
        os: ["linux"],
        cpu: ["arm64"],
        libc: ["musl"],
      },
    },
  });
  install(root, "pi/node_modules/@mariozechner/clipboard-linux-arm64-musl");

  assertPlatformTrees(
    path.join(root, "node_modules"),
    path.join(root, "package-lock.json"),
    MUSL_TARGET,
  );
});

test("prepare-pi-bundle: entries for other platforms are ignored", (t: TestContext) => {
  const root = writeFixture(t, {
    packages: {
      "": { name: "fixture" },
      "node_modules/@rollup/rollup-darwin-arm64": {
        version: "1.0.0",
        optional: true,
        os: ["darwin"],
        cpu: ["arm64"],
      },
      "node_modules/@rollup/rollup-linux-x64-gnu": {
        version: "1.0.0",
        optional: true,
        os: ["linux"],
        cpu: ["x64"],
      },
    },
  });

  const entries = platformEntries(
    path.join(root, "package-lock.json"),
    MUSL_TARGET,
  );
  assert.deepEqual(entries, []);
});

test("prepare-pi-bundle: CLI runs from URL-encoded checkout paths", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bundle-cli-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const scripts = path.join(root, "checkout with spaces #hash", "scripts");
  fs.mkdirSync(path.join(scripts, "lib"), { recursive: true });
  const script = path.join(scripts, "prepare-pi-bundle.mjs");
  fs.copyFileSync(SCRIPT, script);
  fs.copyFileSync(
    new URL("../../scripts/lib/cli.mjs", import.meta.url),
    path.join(scripts, "lib", "cli.mjs"),
  );
  const result = childProcess.spawnSync(process.execPath, [script, "--help"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:.*prepare-pi-bundle/);
});

for (const source of ["runtime", "repo"] as const) {
  for (const manifest of ["package.json", "package-lock.json"]) {
    test(`prepare-pi-bundle: protects ${source} ${manifest} symlinks into owned output`, (t) => {
      const fixture = bundleFixture(t);
      const calls = mockNpm(t);
      const options = {
        repoRoot: fixture.root,
        config: "images/pi-node-base.json",
        deps: [`fixture=${fixture.repo}`],
      };
      const { outDir } = preparePiBundle(options);
      const input = path.join(fixture[source], manifest);
      const original = fs.readFileSync(input, "utf8");
      const protectedFile = path.join(outDir, "manifest-snapshot.json");
      fs.writeFileSync(protectedFile, original);
      fs.unlinkSync(input);
      fs.symlinkSync(protectedFile, input);
      const count = calls.length;
      assert.throws(() => preparePiBundle(options), /overlaps input/);
      assert.equal(fs.readFileSync(protectedFile, "utf8"), original);
      assert.equal(fs.readFileSync(input, "utf8"), original);
      assert.equal(calls.length, count);
    });
  }
}

test("prepare-pi-bundle: protects case-aliased manifest symlink targets", (t) => {
  const fixture = bundleFixture(t);
  const calls = mockNpm(t);
  const options = {
    repoRoot: fixture.root,
    config: "images/pi-node-base.json",
  };
  const { outDir } = preparePiBundle(options);
  const alias = path.join(path.dirname(outDir), "PI-BUNDLE");
  if (!fs.existsSync(alias)) {
    t.skip("requires a case-insensitive filesystem");
    return;
  }
  const input = path.join(fixture.runtime, "package-lock.json");
  const original = fs.readFileSync(input, "utf8");
  const target = path.join(alias, "manifest-snapshot.json");
  fs.writeFileSync(target, original);
  fs.unlinkSync(input);
  fs.symlinkSync(target, input);
  const realpath = fs.realpathSync;
  t.mock.method(fs, "realpathSync", (file: string) =>
    file === input ? target : realpath(file),
  );
  assert.throws(() => preparePiBundle(options), /overlaps input/);
  assert.equal(fs.readFileSync(target, "utf8"), original);
  assert.equal(calls.length, 1);
});

test("prepare-pi-bundle: provenance uses the installed snapshot when source manifests change", (t) => {
  const fixture = bundleFixture(t);
  const calls = mockNpm(t, (_cwd, index) => {
    const source = index === 0 ? fixture.runtime : fixture.repo;
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({ dependencies: { replacement: "9.9.9" } }),
    );
    fs.writeFileSync(
      path.join(source, "package-lock.json"),
      JSON.stringify({
        packages: {
          "node_modules/replacement-linux-arm64-musl": {
            version: "9.9.9",
            optional: true,
            os: ["linux"],
            cpu: ["arm64"],
            libc: ["musl"],
          },
        },
      }),
    );
    return undefined;
  });
  const { provenance } = preparePiBundle({
    repoRoot: fixture.root,
    config: "images/pi-node-base.json",
    deps: [`fixture=${fixture.repo}`],
  });
  assert.equal(provenance.piBundle.package, "runtime-fixture");
  assert.equal(provenance.piBundle.version, "1.2.3");
  assert.equal(
    provenance.piBundle.lockfileSha256,
    crypto.createHash("sha256").update(calls[0].lockfile).digest("hex"),
  );
  assert.equal(
    provenance.bakedRepos[0].lockfileSha256,
    crypto.createHash("sha256").update(calls[1].lockfile).digest("hex"),
  );
  assert.equal(provenance.bakedRepos[0].packageCount, 0);
});

for (const keys of [
  ["app", "app"],
  ["App", "app"],
]) {
  test(`prepare-pi-bundle: rejects duplicate keys ${keys.join("/")} before replacing output`, (t) => {
    const fixture = bundleFixture(t);
    const calls = mockNpm(t);
    const options = {
      repoRoot: fixture.root,
      config: "images/pi-node-base.json",
    };
    const { outDir } = preparePiBundle(options);
    const before = fs.readFileSync(
      path.join(outDir, "provenance.json"),
      "utf8",
    );
    assert.throws(
      () =>
        preparePiBundle({
          ...options,
          deps: keys.map((key) => `${key}=${fixture.repo}`),
        }),
      /duplicate repo key/,
    );
    assert.equal(calls.length, 1);
    assert.equal(
      fs.readFileSync(path.join(outDir, "provenance.json"), "utf8"),
      before,
    );
  });
}

test("prepare-pi-bundle: rejects an empty dependency directory", () => {
  assert.throws(() => parseDepSpecs(["app="]), /<key>=<repo-dir>/);
});

const unsupportedInputs: Array<{
  label: string;
  file: string;
  patch: Record<string, unknown>;
}> = [
  {
    label: "workspaces",
    file: "package.json",
    patch: { workspaces: ["packages/*"] },
  },
  {
    label: "workspace object",
    file: "package.json",
    patch: { workspaces: { packages: ["packages/*"] } },
  },
  ...[
    "file:../lib",
    "file:/abs/lib",
    "file:./lib.tgz",
    "git+file:///local/lib.git",
    "link:../lib",
    "workspace:*",
    "portal:../lib",
    "../lib",
    ".local-lib",
    "vendor/local/lib",
    "owner/repo",
    "/abs/lib",
    "lib.tgz",
    "C:\\lib",
  ].map((spec) => ({
    label: spec,
    file: "package.json",
    patch: { dependencies: { local: spec } },
  })),
  ...["devDependencies", "optionalDependencies", "peerDependencies"].map(
    (field) => ({
      label: field,
      file: "package.json",
      patch: { [field]: { local: "file:../lib" } },
    }),
  ),
  {
    label: "nested override",
    file: "package.json",
    patch: { overrides: { parent: { child: "file:../lib" } } },
  },
  {
    label: "local scoped override reference",
    file: "package.json",
    patch: {
      dependencies: { "@scope/lib": "file:../lib" },
      overrides: { "@scope/lib": "$@scope/lib" },
    },
  },
  ...[
    { link: true, resolved: "packages/lib" },
    { resolved: "file:../lib" },
    { resolved: "../lib" },
    { resolved: "packages/lib" },
    { version: "file:lib.tgz" },
  ].map((entry, index) => ({
    label: `local lock entry ${index}`,
    file: "package-lock.json",
    patch: { packages: { "node_modules/lib": entry } },
  })),
  {
    label: "legacy nested local dependency",
    file: "package-lock.json",
    patch: {
      lockfileVersion: 1,
      packages: undefined,
      dependencies: {
        parent: { dependencies: { local: { version: "file:../lib" } } },
      },
    },
  },
];

for (const source of ["runtime", "repo"] as const) {
  for (const { label, file, patch } of unsupportedInputs) {
    test(`prepare-pi-bundle: rejects ${source} ${label} before replacing owned output`, (t) => {
      const fixture = bundleFixture(t);
      const calls = mockNpm(t);
      const options = {
        repoRoot: fixture.root,
        config: "images/pi-node-base.json",
      };
      const { outDir } = preparePiBundle(options);
      const provenance = path.join(outDir, "provenance.json");
      const before = fs.readFileSync(provenance);
      const input = path.join(fixture[source], file);
      const original = JSON.parse(fs.readFileSync(input, "utf8"));
      fs.writeFileSync(input, JSON.stringify({ ...original, ...patch }));
      assert.throws(
        () =>
          preparePiBundle({ ...options, deps: [`fixture=${fixture.repo}`] }),
        /unsupported.*workspace|unsupported.*local/i,
      );
      assert.equal(calls.length, 1);
      assert.deepEqual(fs.readFileSync(provenance), before);
      assert.ok(fs.existsSync(path.join(outDir, "node_modules", ".bin", "pi")));
      assert.ok(
        !fs.existsSync(path.join(fixture.root, ".gondolin-pi-bundle.lock")),
      );
    });
  }
}

test("prepare-pi-bundle: keeps remote dependencies, npm aliases and override references", (t) => {
  const fixture = bundleFixture(t);
  mockNpm(t);
  fs.writeFileSync(
    path.join(fixture.repo, "package.json"),
    JSON.stringify({
      dependencies: {
        alias: "npm:lib@1.2.3",
        scopedAlias: "npm:@scope/lib@1.2.3",
        "@scope/lib": "^1.2.3",
        hostedGit: "github:owner/repo",
        range: "~1.2.3",
        remote: "https://example.com/lib.tgz",
      },
      overrides: {
        alias: "$alias",
        "@scope/lib": "$@scope/lib",
        parent: { "@scope/lib": "$@scope/lib" },
      },
    }),
  );
  fs.writeFileSync(
    path.join(fixture.repo, "package-lock.json"),
    JSON.stringify({
      packages: {
        "node_modules/lib": {
          version: "1.2.3",
          resolved: "registry.npmjs.org",
        },
        "node_modules/remote": { resolved: "https://example.com/lib.tgz" },
        "node_modules/git": {
          resolved: "git+ssh://git@example.com/lib.git#abc",
        },
      },
    }),
  );
  const { provenance } = preparePiBundle({
    repoRoot: fixture.root,
    config: "images/pi-node-base.json",
    deps: [`fixture=${fixture.repo}`],
  });
  assert.equal(provenance.bakedRepos.length, 1);
});

test("prepare-pi-bundle: installs the validated repo snapshot when sources change before its stage", (t) => {
  const fixture = bundleFixture(t);
  const expected = fs.readFileSync(
    path.join(fixture.repo, "package.json"),
    "utf8",
  );
  const calls = mockNpm(t, (_cwd, index) => {
    if (index === 0) {
      fs.writeFileSync(
        path.join(fixture.repo, "package.json"),
        JSON.stringify({
          workspaces: ["packages/*"],
          dependencies: { local: "file:../lib" },
        }),
      );
    }
    return undefined;
  });
  preparePiBundle({
    repoRoot: fixture.root,
    config: "images/pi-node-base.json",
    deps: [`fixture=${fixture.repo}`],
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].manifest, expected);
});

test("prepare-pi-bundle: --deps specs need a key and a repo dir", () => {
  const repos = parseDepSpecs(["pi-config=/srv/pi-config"]);
  assert.equal(repos[0].key, "pi-config");
  assert.ok(path.isAbsolute(repos[0].dir));

  assert.throws(() => parseDepSpecs(["pi-config"]), /<key>=<repo-dir>/);
  assert.throws(() => parseDepSpecs(["../escape=/srv/x"]), /invalid repo key/);
});
