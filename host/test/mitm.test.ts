import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test, { type TestContext } from "node:test";

import {
  certificateHasNonNegativeSerialNumber,
  generatePositiveSerialNumber,
  getCertificateSubjectKeyIdentifier,
  getDefaultMitmCertDir,
  loadOrCreateMitmCa,
  loadOrCreateMitmCaSync,
  mitmCaHasRequiredKeyIdentifiers,
  resolveMitmCertDir,
} from "../src/mitm.ts";
import { createLegacyCertificate, getKeyUsageBits } from "./helpers/certs.ts";

function makeTempDir(t: TestContext, prefix = "gondolin-mitm-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function assertLooksLikeMitmCa(ca: {
  keyPem: string;
  certPem: string;
  key: crypto.KeyObject;
  cert: crypto.X509Certificate;
}) {
  assert.ok(ca.keyPem.includes("BEGIN RSA PRIVATE KEY"));
  assert.ok(ca.certPem.includes("BEGIN CERTIFICATE"));

  const cert = new crypto.X509Certificate(ca.certPem);
  const key = crypto.createPrivateKey(ca.keyPem);

  // CN
  assert.equal(cert.subject, "CN=gondolin-mitm-ca");

  // Self-signed
  assert.equal(cert.issuer, "CN=gondolin-mitm-ca");
  assert.equal(cert.checkIssued(cert), true);
  assert.equal(cert.verify(cert.publicKey), true);

  // Certificate is a CA
  assert.equal(cert.ca, true);

  // Key usage
  const keyUsage = getKeyUsageBits(cert);
  assert.ok(keyUsage);
  assert.deepEqual([...keyUsage.bits].sort(), [5, 6]); // keyCertSign, cRLSign
  assert.equal(keyUsage.critical, true);

  // Key identifiers are required by strict TLS clients (e.g. Python/OpenSSL)
  assert.ok(getCertificateSubjectKeyIdentifier(cert));
  assert.equal(mitmCaHasRequiredKeyIdentifiers(cert), true);

  // Serial number must remain non-negative for strict TLS clients (e.g. Go)
  assert.equal(certificateHasNonNegativeSerialNumber(cert), true);

  // Validity window (10 years)
  const notBefore = Date.parse(cert.validFrom);
  const notAfter = Date.parse(cert.validTo);
  assert.ok(notAfter > notBefore);
  const days = (notAfter - notBefore) / (24 * 60 * 60 * 1000);
  assert.ok(days > 3600 && days < 3700);

  // Public/private key match
  assert.equal(cert.checkPrivateKey(key), true);
}

test("mitm getDefaultMitmCertDir respects XDG_CACHE_HOME", (t) => {
  const prev = process.env.XDG_CACHE_HOME;
  t.after(() => {
    if (prev === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = prev;
  });

  process.env.XDG_CACHE_HOME = "/tmp/gondolin-xdg-cache-test";
  assert.equal(
    getDefaultMitmCertDir(),
    path.join("/tmp/gondolin-xdg-cache-test", "gondolin", "ssl"),
  );
});

test("mitm resolveMitmCertDir uses override", () => {
  assert.equal(resolveMitmCertDir("/custom/dir"), "/custom/dir");
});

test("mitm serial helpers create positive serial numbers", () => {
  for (let i = 0; i < 64; i += 1) {
    const serial = generatePositiveSerialNumber();
    assert.equal(serial.length, 16);
    assert.ok(serial[0] > 0 && serial[0] < 0x80);
  }

  const negative = createLegacyCertificate({
    commonName: "negative-serial",
    serialNumber: Buffer.from([0xff]),
  });
  assert.equal(
    certificateHasNonNegativeSerialNumber(
      new crypto.X509Certificate(negative.certPem),
    ),
    false,
  );

  // A leading zero octet keeps a high first content byte positive
  const padded = createLegacyCertificate({
    commonName: "padded-serial",
    serialNumber: Buffer.from([0x00, 0xff]),
  });
  assert.equal(
    certificateHasNonNegativeSerialNumber(
      new crypto.X509Certificate(padded.certPem),
    ),
    true,
  );
});

test("mitm loadOrCreateMitmCaSync creates and persists CA", (t) => {
  const dir = makeTempDir(t);

  const ca1 = loadOrCreateMitmCaSync(dir);
  assertLooksLikeMitmCa(ca1);

  // Files created
  const keyPath = path.join(dir, "ca.key");
  const certPath = path.join(dir, "ca.crt");
  assert.equal(fs.existsSync(keyPath), true);
  assert.equal(fs.existsSync(certPath), true);
  assert.equal(fs.readFileSync(keyPath, "utf8"), ca1.keyPem);
  assert.equal(fs.readFileSync(certPath, "utf8"), ca1.certPem);

  // Second load reuses persisted materials
  const ca2 = loadOrCreateMitmCaSync(dir);
  assert.equal(ca2.keyPem, ca1.keyPem);
  assert.equal(ca2.certPem, ca1.certPem);
});

test("mitm loadOrCreateMitmCaSync regenerates CA with unsafe serial", (t) => {
  const dir = makeTempDir(t);

  const bad = createLegacyCertificate({
    commonName: "gondolin-mitm-ca",
    serialNumber: Buffer.from([0xff]),
  });
  fs.writeFileSync(path.join(dir, "ca.key"), bad.keyPem);
  fs.writeFileSync(path.join(dir, "ca.crt"), bad.certPem);

  const loaded = loadOrCreateMitmCaSync(dir);
  assertLooksLikeMitmCa(loaded);
  assert.notEqual(loaded.certPem, bad.certPem);
});

test("mitm loadOrCreateMitmCaSync regenerates CA missing key identifiers", (t) => {
  const dir = makeTempDir(t);

  const legacy = createLegacyCertificate({
    commonName: "gondolin-mitm-ca",
    serialNumber: Buffer.from([0x01]),
  });
  fs.writeFileSync(path.join(dir, "ca.key"), legacy.keyPem);
  fs.writeFileSync(path.join(dir, "ca.crt"), legacy.certPem);

  const loaded = loadOrCreateMitmCaSync(dir);
  assertLooksLikeMitmCa(loaded);
  assert.notEqual(loaded.certPem, legacy.certPem);
});

test("mitm loadOrCreateMitmCaSync regenerates CA with mismatched key", (t) => {
  const dir = makeTempDir(t);

  const original = loadOrCreateMitmCaSync(dir);
  const otherKey = crypto
    .generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" }) as string;
  fs.writeFileSync(path.join(dir, "ca.key"), otherKey);

  const loaded = loadOrCreateMitmCaSync(dir);
  assertLooksLikeMitmCa(loaded);
  assert.notEqual(loaded.certPem, original.certPem);
});

test("mitm loadOrCreateMitmCa async loads existing CA generated by sync", async (t) => {
  const dir = makeTempDir(t);

  const sync = loadOrCreateMitmCaSync(dir);
  const asyncCa = await loadOrCreateMitmCa(dir);

  assert.equal(asyncCa.keyPem, sync.keyPem);
  assert.equal(asyncCa.certPem, sync.certPem);
});

test("mitm loadOrCreateMitmCa regenerates when files are missing/corrupt", async (t) => {
  const dir = makeTempDir(t);

  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "ca.key"), "not a key");
  // no cert

  const ca = await loadOrCreateMitmCa(dir);
  assertLooksLikeMitmCa(ca);

  // Corrupt file should have been overwritten
  assert.notEqual(
    fs.readFileSync(path.join(dir, "ca.key"), "utf8"),
    "not a key",
  );
});
