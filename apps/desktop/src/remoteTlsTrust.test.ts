import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createRemoteTlsTrustController } from "./remoteTlsTrust";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeFingerprint(byte = "AA"): string {
  return Array.from({ length: 32 }, () => byte).join(":");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("remoteTlsTrust", () => {
  it("pins certificates by exact hostname and fingerprint and persists them", async () => {
    const stateDir = makeTempDir("t3code-remote-tls-");
    const fingerprint = makeFingerprint();
    const controller = createRemoteTlsTrustController(stateDir);
    await controller.trustRemoteTlsCertificate({
      url: "wss://remote.example.com",
      fingerprintSha256: fingerprint,
    });

    const reloadedController = createRemoteTlsTrustController(stateDir);
    let verifyProc:
      | ((
          request: { hostname: string; certificate?: { fingerprint?: string } },
          callback: (result: number) => void,
        ) => void)
      | null = null;
    const session = {
      setCertificateVerifyProc: vi.fn((listener) => {
        verifyProc = listener as typeof verifyProc;
      }),
    };

    reloadedController.installCertificateVerifyProc(session as never);
    expect(session.setCertificateVerifyProc).toHaveBeenCalledTimes(1);
    if (!verifyProc) {
      throw new Error("Expected certificate verify callback");
    }

    const verify = (request: { hostname: string; certificate?: { fingerprint?: string } }) =>
      new Promise<number>((resolve) => {
        verifyProc?.(request, (result) => resolve(result));
      });

    await expect(
      verify({
        hostname: "remote.example.com",
        certificate: { fingerprint },
      }),
    ).resolves.toBe(0);
    await expect(
      verify({
        hostname: "other.example.com",
        certificate: { fingerprint },
      }),
    ).resolves.toBe(-3);
    await expect(
      verify({
        hostname: "remote.example.com",
        certificate: { fingerprint: makeFingerprint("BB") },
      }),
    ).resolves.toBe(-3);
  });
});
