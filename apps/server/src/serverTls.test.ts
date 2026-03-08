import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import { afterEach, describe, expect, it } from "vitest";

import { resolveServerTlsConfig, rotateServerTlsConfig } from "./serverTls";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0, tempDirs.length)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("serverTls", () => {
  it("creates and reuses a persisted self-signed certificate", async () => {
    const stateDir = makeTempDir("t3code-server-tls-");

    const initial = await Effect.runPromise(
      resolveServerTlsConfig({
        enabled: true,
        stateDir,
        host: "127.0.0.1",
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const reused = await Effect.runPromise(
      resolveServerTlsConfig({
        enabled: true,
        stateDir,
        host: "127.0.0.1",
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(initial?.workspaceTls.mode).toBe("self-signed");
    expect(initial?.workspaceTls.fingerprintSha256).toBeTruthy();
    expect(reused?.workspaceTls.fingerprintSha256).toBe(initial?.workspaceTls.fingerprintSha256);
    expect(fs.existsSync(path.join(stateDir, "server-self-signed-cert.pem"))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, "server-self-signed-key.pem"))).toBe(true);
  });

  it("rotates the persisted self-signed certificate", async () => {
    const stateDir = makeTempDir("t3code-server-tls-rotate-");

    const initial = await Effect.runPromise(
      resolveServerTlsConfig({
        enabled: true,
        stateDir,
        host: "127.0.0.1",
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const rotated = await Effect.runPromise(
      rotateServerTlsConfig({
        enabled: true,
        stateDir,
        host: "127.0.0.1",
      }).pipe(Effect.provide(NodeServices.layer)),
    );
    const reloaded = await Effect.runPromise(
      resolveServerTlsConfig({
        enabled: true,
        stateDir,
        host: "127.0.0.1",
      }).pipe(Effect.provide(NodeServices.layer)),
    );

    expect(rotated?.workspaceTls.mode).toBe("self-signed");
    expect(rotated?.workspaceTls.fingerprintSha256).toBeTruthy();
    expect(rotated?.workspaceTls.fingerprintSha256).not.toBe(initial?.workspaceTls.fingerprintSha256);
    expect(reloaded?.workspaceTls.fingerprintSha256).toBe(rotated?.workspaceTls.fingerprintSha256);
  });
});
