import { getCACertificates } from 'node:tls';
import { createHash } from 'node:crypto';

/** Inspect actual trust loaded by this process, without a network request. */
export function inspectRuntimeTrust(
  certificates = getCACertificates,
  env: {
    NODE_EXTRA_CA_CERTS?: string;
    NODE_TLS_REJECT_UNAUTHORIZED?: string;
  } = {
    NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS,
    NODE_TLS_REJECT_UNAUTHORIZED: process.env.NODE_TLS_REJECT_UNAUTHORIZED,
  },
  platform: string = process.platform,
) {
  const defaults = certificates('default'),
    system = certificates('system');
  const active = new Set(defaults);
  const missingSystemCertificates = system.filter(
    (cert) => !active.has(cert),
  ).length;
  return {
    node: process.version,
    platform,
    defaultCertificates: defaults.length,
    systemCertificates: system.length,
    missingSystemCertificates,
    trustDigest: createHash('sha256')
      .update([...new Set(defaults)].sort().join('\n'))
      .digest('hex'),
    extraCAConfigured: !!env.NODE_EXTRA_CA_CERTS,
    tlsVerificationEnabled: env.NODE_TLS_REJECT_UNAUTHORIZED !== '0',
    ready:
      env.NODE_TLS_REJECT_UNAUTHORIZED !== '0' &&
      defaults.length > 0 &&
      missingSystemCertificates === 0 &&
      (platform !== 'win32' || system.length > 0),
  };
}
