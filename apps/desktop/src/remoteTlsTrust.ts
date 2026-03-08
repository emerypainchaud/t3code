import * as FS from "node:fs";
import * as Path from "node:path";
import * as TLS from "node:tls";

import type {
  DesktopRemoteTlsCertificateInspection,
  DesktopTrustRemoteTlsCertificateInput,
} from "@t3tools/contracts";
import type { Certificate, Session } from "electron";

const TRUST_STORE_FILENAME = "trusted-remote-certificates.json";
const DEFAULT_TLS_PORT = 443;
const INSPECTION_TIMEOUT_MS = 5_000;

interface TrustedRemoteCertificateStore {
  version: 1;
  hosts: Record<string, string[]>;
}

interface TrustedRemoteCertificateIndex {
  has(hostname: string, fingerprintSha256: string): boolean;
  add(hostname: string, fingerprintSha256: string): void;
  toJSON(): TrustedRemoteCertificateStore;
}

function normalizeHostname(hostname: string): string {
  const trimmed = hostname.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

function normalizeFingerprintSha256(input: string): string | null {
  const hex = input.toUpperCase().replace(/[^A-F0-9]/g, "");
  if (hex.length !== 64) {
    return null;
  }
  const parts = hex.match(/.{2}/g);
  return parts ? parts.join(":") : null;
}

function loadTrustedRemoteCertificateStore(stateDir: string): TrustedRemoteCertificateIndex {
  const filePath = Path.join(stateDir, TRUST_STORE_FILENAME);
  const raw = (() => {
    try {
      return FS.readFileSync(filePath, "utf8");
    } catch {
      return "";
    }
  })();

  const parsed = (() => {
    if (raw.trim().length === 0) {
      return { version: 1, hosts: {} } satisfies TrustedRemoteCertificateStore;
    }
    try {
      const candidate = JSON.parse(raw) as Partial<TrustedRemoteCertificateStore>;
      return {
        version: 1,
        hosts:
          candidate && typeof candidate === "object" && candidate.hosts && typeof candidate.hosts === "object"
            ? Object.fromEntries(
                Object.entries(candidate.hosts).map(([hostname, fingerprints]) => [
                  normalizeHostname(hostname),
                  Array.isArray(fingerprints)
                    ? fingerprints
                        .map((fingerprint) =>
                          typeof fingerprint === "string"
                            ? normalizeFingerprintSha256(fingerprint)
                            : null,
                        )
                        .filter((fingerprint): fingerprint is string => fingerprint !== null)
                    : [],
                ]),
              )
            : {},
      } satisfies TrustedRemoteCertificateStore;
    } catch {
      return { version: 1, hosts: {} } satisfies TrustedRemoteCertificateStore;
    }
  })();

  const hosts = new Map<string, Set<string>>(
    Object.entries(parsed.hosts).map(([hostname, fingerprints]) => [
      normalizeHostname(hostname),
      new Set(fingerprints),
    ]),
  );

  const persist = () => {
    FS.mkdirSync(stateDir, { recursive: true });
    FS.writeFileSync(
      filePath,
      `${JSON.stringify(
        {
          version: 1,
          hosts: Object.fromEntries(
            [...hosts.entries()].map(([hostname, fingerprints]) => [hostname, [...fingerprints].toSorted()]),
          ),
        } satisfies TrustedRemoteCertificateStore,
        null,
        2,
      )}\n`,
      "utf8",
    );
  };

  return {
    has(hostname, fingerprintSha256) {
      const normalizedFingerprint = normalizeFingerprintSha256(fingerprintSha256);
      if (!normalizedFingerprint) {
        return false;
      }
      return hosts.get(normalizeHostname(hostname))?.has(normalizedFingerprint) ?? false;
    },
    add(hostname, fingerprintSha256) {
      const normalizedFingerprint = normalizeFingerprintSha256(fingerprintSha256);
      if (!normalizedFingerprint) {
        throw new Error("Certificate fingerprint is invalid.");
      }
      const normalizedHostname = normalizeHostname(hostname);
      const fingerprints = hosts.get(normalizedHostname) ?? new Set<string>();
      fingerprints.add(normalizedFingerprint);
      hosts.set(normalizedHostname, fingerprints);
      persist();
    },
    toJSON() {
      return {
        version: 1,
        hosts: Object.fromEntries(
          [...hosts.entries()].map(([hostname, fingerprints]) => [hostname, [...fingerprints].toSorted()]),
        ),
      } satisfies TrustedRemoteCertificateStore;
    },
  } satisfies TrustedRemoteCertificateIndex;
}

function getTlsInspectionTarget(url: string): { hostname: string; port: number } {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("Enter a valid wss:// or https:// server URL.");
  }

  if (parsedUrl.protocol !== "wss:" && parsedUrl.protocol !== "https:") {
    throw new Error("Certificate trust is only available for secure wss:// or https:// servers.");
  }

  return {
    hostname: normalizeHostname(parsedUrl.hostname),
    port: parsedUrl.port.length > 0 ? Number(parsedUrl.port) : DEFAULT_TLS_PORT,
  };
}

function isSelfSignedCertificate(input: {
  authorizationError: string | null;
  subjectName: string | null;
  issuerName: string | null;
}): boolean {
  return (
    input.authorizationError === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    input.authorizationError === "SELF_SIGNED_CERT_IN_CHAIN" ||
    (input.subjectName !== null && input.subjectName === input.issuerName)
  );
}

export function createRemoteTlsTrustController(stateDir: string): {
  inspectRemoteTlsCertificate: (url: string) => Promise<DesktopRemoteTlsCertificateInspection>;
  trustRemoteTlsCertificate: (input: DesktopTrustRemoteTlsCertificateInput) => Promise<void>;
  installCertificateVerifyProc: (session: Session) => void;
} {
  const trustedCertificates = loadTrustedRemoteCertificateStore(stateDir);

  const isTrustedByPinnedFingerprint = (hostname: string, fingerprintSha256: string | null): boolean => {
    if (!fingerprintSha256) {
      return false;
    }
    return trustedCertificates.has(hostname, fingerprintSha256);
  };

  const inspectRemoteTlsCertificate = async (
    url: string,
  ): Promise<DesktopRemoteTlsCertificateInspection> => {
    const { hostname, port } = getTlsInspectionTarget(url);

    return new Promise<DesktopRemoteTlsCertificateInspection>((resolve, reject) => {
      const socket = TLS.connect(
        {
          host: hostname,
          port,
          servername: hostname,
          rejectUnauthorized: false,
        },
        () => {
          try {
            const certificate = socket.getPeerCertificate(true);
            const fingerprintSha256 = normalizeFingerprintSha256(certificate.fingerprint256 ?? "");
            if (!fingerprintSha256) {
              throw new Error("The remote server did not present a usable TLS certificate.");
            }

            const subjectName = typeof certificate.subject?.CN === "string" ? certificate.subject.CN : null;
            const issuerName = typeof certificate.issuer?.CN === "string" ? certificate.issuer.CN : null;
            const verificationError = socket.authorized
              ? null
              : socket.authorizationError instanceof Error
                ? socket.authorizationError.message
                : socket.authorizationError ?? null;

            resolve({
              url,
              hostname,
              fingerprintSha256,
              subjectName,
              issuerName,
              validFrom: typeof certificate.valid_from === "string" ? certificate.valid_from : null,
              validTo: typeof certificate.valid_to === "string" ? certificate.valid_to : null,
              verificationError,
              trusted: isTrustedByPinnedFingerprint(hostname, fingerprintSha256),
              selfSigned: isSelfSignedCertificate({
                authorizationError: verificationError,
                subjectName,
                issuerName,
              }),
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          } finally {
            socket.end();
          }
        },
      );

      socket.setTimeout(INSPECTION_TIMEOUT_MS, () => {
        socket.destroy(new Error("Timed out while reading the remote server certificate."));
      });
      socket.once("error", (error) => {
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  };

  const trustRemoteTlsCertificate = async (
    input: DesktopTrustRemoteTlsCertificateInput,
  ): Promise<void> => {
    const { hostname } = getTlsInspectionTarget(input.url);
    const fingerprintSha256 = normalizeFingerprintSha256(input.fingerprintSha256);
    if (!fingerprintSha256) {
      throw new Error("Certificate fingerprint is invalid.");
    }
    trustedCertificates.add(hostname, fingerprintSha256);
  };

  const installCertificateVerifyProc = (session: Session): void => {
    session.setCertificateVerifyProc((request, callback) => {
      const fingerprintSha256 = normalizeFingerprintSha256(
        ((request.certificate as Certificate | undefined)?.fingerprint ?? "").trim(),
      );
      if (isTrustedByPinnedFingerprint(request.hostname, fingerprintSha256)) {
        callback(0);
        return;
      }
      callback(-3);
    });
  };

  return {
    inspectRemoteTlsCertificate,
    trustRemoteTlsCertificate,
    installCertificateVerifyProc,
  };
}
