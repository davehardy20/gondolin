import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import tls from "node:tls";

import {
  caCertVerifiesLeaf,
  generateMitmLeaf,
  loadOrCreateMitmCaSync,
  mitmLeafHasRequiredKeyIdentifiers,
  privateKeyMatchesLeafCert,
  validateMitmLeaf,
} from "../src/mitm.ts";
import {
  decodeOid,
  ipAddressToBytes,
  parseCertificate,
  readDer,
} from "../src/x509.ts";
import { getKeyUsageBits } from "./helpers/certs.ts";

function makeCa(t: TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gondolin-x509-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return loadOrCreateMitmCaSync(dir);
}

test("x509 ipAddressToBytes encodes v4 and v6 addresses", () => {
  assert.deepEqual([...ipAddressToBytes("192.0.2.1")], [192, 0, 2, 1]);
  assert.equal(
    ipAddressToBytes("::1").toString("hex"),
    "00000000000000000000000000000001",
  );
  assert.equal(
    ipAddressToBytes("2001:db8::8:800:200c:417a").toString("hex"),
    "20010db80000000000080800200c417a",
  );
  assert.equal(
    ipAddressToBytes("::ffff:192.0.2.1").toString("hex"),
    "00000000000000000000ffffc0000201",
  );
  assert.equal(
    ipAddressToBytes("fe80::1%eth0").toString("hex"),
    "fe800000000000000000000000000001",
  );
  assert.throws(() => ipAddressToBytes("example.com"));
});

test("x509 decodeOid round-trips multi-byte arcs", () => {
  // 1.2.840.113549.1.1.11 (sha256WithRSAEncryption)
  const oid = Buffer.from("2a864886f70d01010b", "hex");
  assert.equal(decodeOid(oid), "1.2.840.113549.1.1.11");
});

test("x509 readDer rejects truncated input", () => {
  assert.throws(() => readDer(Buffer.from([0x30, 0x05, 0x00])));
  assert.throws(() => readDer(Buffer.from([0x30, 0x84, 0xff])));
});

test("x509 mitm leaf certificates carry expected fields", async (t) => {
  const ca = makeCa(t);
  const leaf = await generateMitmLeaf(ca, "example.test");
  const cert = new crypto.X509Certificate(leaf.certPem);

  assert.equal(cert.subject, "CN=example.test");
  assert.equal(cert.issuer, "CN=gondolin-mitm-ca");
  assert.equal(cert.subjectAltName, "DNS:example.test");
  assert.equal(cert.checkHost("example.test"), "example.test");
  assert.equal(cert.ca, false);
  assert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.1"]);
  assert.deepEqual(
    [...(getKeyUsageBits(cert)?.bits ?? [])].sort(),
    [0, 2], // digitalSignature, keyEncipherment
  );
  assert.equal(caCertVerifiesLeaf(ca.cert, cert), true);
  assert.equal(mitmLeafHasRequiredKeyIdentifiers(ca.cert, cert), true);
  assert.equal(privateKeyMatchesLeafCert(leaf.keyPem, cert), true);
  assert.doesNotThrow(() => validateMitmLeaf(ca, leaf));

  // Issuer is copied verbatim from the ca subject
  assert.ok(
    parseCertificate(cert.raw).issuer.equals(
      parseCertificate(ca.cert.raw).subject,
    ),
  );

  const days =
    (Date.parse(cert.validTo) - Date.parse(cert.validFrom)) /
    (24 * 60 * 60 * 1000);
  assert.equal(days, 825);
});

test("x509 mitm leaf certificates support ip address names", async (t) => {
  const ca = makeCa(t);

  const v4 = new crypto.X509Certificate(
    (await generateMitmLeaf(ca, "192.0.2.1")).certPem,
  );
  assert.equal(v4.subjectAltName, "IP Address:192.0.2.1");
  assert.equal(v4.checkIP("192.0.2.1"), "192.0.2.1");

  const v6 = new crypto.X509Certificate(
    (await generateMitmLeaf(ca, "2001:db8::1")).certPem,
  );
  assert.equal(v6.checkIP("2001:db8::1"), "2001:db8::1");
});

test("x509 validateMitmLeaf rejects leaves from another ca or key", async (t) => {
  const ca = makeCa(t);
  const otherCa = makeCa(t);
  const leaf = await generateMitmLeaf(ca, "example.test");
  const otherLeaf = await generateMitmLeaf(ca, "example.test");

  assert.throws(() => validateMitmLeaf(otherCa, leaf), /not signed/);
  assert.throws(
    () => validateMitmLeaf(ca, { ...leaf, keyPem: otherLeaf.keyPem }),
    /key does not match/,
  );
});

test("x509 mitm chain is accepted by a verifying tls client", async (t) => {
  const ca = makeCa(t);
  const leaf = await generateMitmLeaf(ca, "example.test");

  const server = tls.createServer(
    { key: leaf.keyPem, cert: `${leaf.certPem}\n${ca.certPem}` },
    (socket) => socket.end("ok"),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());

  const { port } = server.address() as AddressInfo;
  const data = await new Promise<string>((resolve, reject) => {
    const socket = tls.connect({
      host: "127.0.0.1",
      port,
      servername: "example.test",
      ca: [ca.certPem],
      rejectUnauthorized: true,
    });
    let received = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => (received += chunk));
    socket.on("end", () => resolve(received));
    socket.on("error", reject);
  });
  assert.equal(data, "ok");
});
