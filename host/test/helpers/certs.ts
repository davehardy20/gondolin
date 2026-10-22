import crypto from "node:crypto";

import {
  basicConstraintsExtension,
  createCertificate,
  encodeCommonNameName,
  extKeyUsageExtension,
  getExtension,
  keyUsageExtension,
  OID_SERVER_AUTH,
  parseCertificate,
  readDer,
  subjectAltNameExtension,
} from "../../src/x509.ts";

/**
 * Certificate without subject/authority key identifiers, mimicking material
 * written by older gondolin versions
 */
export function createLegacyCertificate(options: {
  commonName: string;
  /** DER integer content octets of the serial number */
  serialNumber: Buffer;
  /** issuer key and certificate (self-signed CA when omitted) */
  issuer?: { key: crypto.KeyObject; cert: crypto.X509Certificate };
  /** leaf subject alternative name (CA when omitted) */
  subjectAltName?: string;
}): { keyPem: string; certPem: string } {
  const keys = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const subject = encodeCommonNameName(options.commonName);
  const notBefore = new Date(Date.now() - 5 * 60 * 1000);
  const isCa = options.subjectAltName === undefined;

  const der = createCertificate({
    publicKey: keys.publicKey,
    signingKey: options.issuer?.key ?? keys.privateKey,
    serialNumber: options.serialNumber,
    notBefore,
    notAfter: new Date(
      notBefore.getTime() + (isCa ? 3650 : 825) * 24 * 60 * 60 * 1000,
    ),
    subject,
    issuer: options.issuer
      ? parseCertificate(options.issuer.cert.raw).subject
      : subject,
    extensions: isCa
      ? [
          basicConstraintsExtension({ ca: true, critical: true }),
          keyUsageExtension({ keyCertSign: true, cRLSign: true }, true),
        ]
      : [
          basicConstraintsExtension({ ca: false }),
          keyUsageExtension({ digitalSignature: true, keyEncipherment: true }),
          extKeyUsageExtension([OID_SERVER_AUTH]),
          subjectAltNameExtension(options.subjectAltName!),
        ],
  });

  return {
    keyPem: keys.privateKey.export({ type: "pkcs1", format: "pem" }) as string,
    certPem: new crypto.X509Certificate(der).toString(),
  };
}

/** Decode the KeyUsage extension into the set of asserted bit positions */
export function getKeyUsageBits(
  cert: crypto.X509Certificate,
): { bits: Set<number>; critical: boolean } | undefined {
  const ext = getExtension(parseCertificate(cert.raw), "2.5.29.15");
  if (!ext) return undefined;
  const bitString = readDer(ext.value).content;
  const bits = new Set<number>();
  for (let i = 1; i < bitString.length; i++) {
    for (let bit = 0; bit < 8; bit++) {
      if (bitString[i] & (0x80 >> bit)) bits.add((i - 1) * 8 + bit);
    }
  }
  return { bits, critical: ext.critical };
}
