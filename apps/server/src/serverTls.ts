import os from "node:os";
import { isIP } from "node:net";
import https from "node:https";
import { X509Certificate } from "node:crypto";

import type { ServerWorkspaceTls } from "@t3tools/contracts";
import { Effect, FileSystem, Path } from "effect";
import selfsigned from "selfsigned";

const SELF_SIGNED_CERT_FILENAME = "server-self-signed-cert.pem";
const SELF_SIGNED_KEY_FILENAME = "server-self-signed-key.pem";
const SELF_SIGNED_CERT_VALIDITY_MS = 3650 * 24 * 60 * 60 * 1000;

type SubjectAltNameExtension = {
  name: "subjectAltName";
  altNames: Array<
    | {
        type: 2;
        value: string;
      }
    | {
        type: 7;
        ip: string;
      }
  >;
};

export interface ResolvedServerTlsConfig {
  readonly httpsOptions: https.ServerOptions;
  readonly workspaceTls: ServerWorkspaceTls;
}

class ServerTlsSetupError extends Error {
  readonly _tag = "ServerTlsSetupError";

  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ServerTlsSetupError";
  }
}

interface ResolveServerTlsConfigInput {
  readonly enabled: boolean;
  readonly stateDir: string;
  readonly host: string | undefined;
}

function normalizeCertificateDate(input: string): string | undefined {
  const timestamp = Date.parse(input);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
}

function collectSubjectAltNames(host: string | undefined): [SubjectAltNameExtension] {
  const hostnames = new Set<string>(["localhost"]);
  const ipAddresses = new Set<string>(["127.0.0.1", "::1"]);
  const normalizedHost = host?.trim();

  if (
    normalizedHost &&
    normalizedHost !== "0.0.0.0" &&
    normalizedHost !== "::" &&
    normalizedHost !== "[::]"
  ) {
    const unwrappedHost = stripIpv6Brackets(normalizedHost);
    if (isIP(unwrappedHost)) {
      ipAddresses.add(unwrappedHost);
    } else {
      hostnames.add(unwrappedHost.toLowerCase());
    }
  } else {
    const interfaces = os.networkInterfaces();
    for (const addresses of Object.values(interfaces)) {
      for (const address of addresses ?? []) {
        if (address.internal) {
          continue;
        }
        if (address.family === "IPv4" || address.family === "IPv6") {
          ipAddresses.add(address.address);
        }
      }
    }
  }

  return [
    {
      name: "subjectAltName",
      altNames: [
        ...[...hostnames].map((value) => ({ type: 2 as const, value })),
        ...[...ipAddresses].map((ip) => ({ type: 7 as const, ip })),
      ],
    },
  ];
}

function createWorkspaceTlsMetadata(certPem: string): ServerWorkspaceTls {
  const certificate = new X509Certificate(certPem);
  return {
    mode: "self-signed",
    fingerprintSha256: certificate.fingerprint256,
    ...(normalizeCertificateDate(certificate.validFrom)
      ? { validFrom: normalizeCertificateDate(certificate.validFrom) }
      : {}),
    ...(normalizeCertificateDate(certificate.validTo)
      ? { validTo: normalizeCertificateDate(certificate.validTo) }
      : {}),
  };
}

function loadOrCreateServerTlsConfig(
  input: ResolveServerTlsConfigInput & { readonly rotate: boolean },
) {
  return Effect.gen(function* () {
    if (!input.enabled) {
      return null;
    }

    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const certPath = path.join(input.stateDir, SELF_SIGNED_CERT_FILENAME);
    const keyPath = path.join(input.stateDir, SELF_SIGNED_KEY_FILENAME);

    let certPem = input.rotate
      ? ""
      : yield* fileSystem.readFileString(certPath).pipe(Effect.catch(() => Effect.succeed("")));
    let keyPem = input.rotate
      ? ""
      : yield* fileSystem.readFileString(keyPath).pipe(Effect.catch(() => Effect.succeed("")));

    if (certPem.trim().length === 0 || keyPem.trim().length === 0) {
      const commonName = stripIpv6Brackets(input.host?.trim() || "localhost");
      const generated = yield* Effect.tryPromise({
        try: () =>
          selfsigned.generate([{ name: "commonName", value: commonName }], {
            algorithm: "sha256",
            keySize: 2048,
            notAfterDate: new Date(Date.now() + SELF_SIGNED_CERT_VALIDITY_MS),
            extensions: collectSubjectAltNames(input.host),
          }),
        catch: (cause) =>
          new ServerTlsSetupError(
            `Unable to generate a self-signed certificate: ${String(cause)}`,
            cause,
          ),
      });

      certPem = generated.cert;
      keyPem = generated.private;

      yield* fileSystem
        .makeDirectory(input.stateDir, { recursive: true })
        .pipe(Effect.catch(() => Effect.void));
      yield* Effect.all([
        fileSystem.writeFileString(certPath, `${certPem.trim()}\n`),
        fileSystem.writeFileString(keyPath, `${keyPem.trim()}\n`),
      ]).pipe(
        Effect.mapError(
          (cause) =>
            new ServerTlsSetupError(
              `Unable to persist self-signed certificate files: ${String(cause)}`,
              cause,
            ),
        ),
      );
    }

    const workspaceTls = yield* Effect.try({
      try: () => createWorkspaceTlsMetadata(certPem),
      catch: (cause) =>
        new ServerTlsSetupError(
          `Unable to read workspace TLS certificate metadata: ${String(cause)}`,
          cause,
        ),
    });

    return {
      httpsOptions: {
        cert: certPem,
        key: keyPem,
      },
      workspaceTls,
    } satisfies ResolvedServerTlsConfig;
  });
}

export const resolveServerTlsConfig = (
  input: ResolveServerTlsConfigInput,
): Effect.Effect<
  ResolvedServerTlsConfig | null,
  ServerTlsSetupError,
  FileSystem.FileSystem | Path.Path
> => loadOrCreateServerTlsConfig({ ...input, rotate: false });

export const rotateServerTlsConfig = (
  input: ResolveServerTlsConfigInput,
): Effect.Effect<
  ResolvedServerTlsConfig | null,
  ServerTlsSetupError,
  FileSystem.FileSystem | Path.Path
> => loadOrCreateServerTlsConfig({ ...input, rotate: true });
