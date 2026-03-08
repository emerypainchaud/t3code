import crypto from "node:crypto";
import * as Http from "node:http";
import * as TLS from "node:tls";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, PlatformError, Scope } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { SqlClient, SqlError } from "effect/unstable/sql";
import { MigrationError } from "@effect/sql-sqlite-bun/SqliteMigrator";

import { createServer } from "./wsServer";
import { ServerConfig, type ServerConfigShape } from "./config";
import { makeServerProviderLayer, makeServerRuntimeServicesLayer } from "./serverLayers";
import { ProviderHealth, type ProviderHealthShape } from "./provider/Services/ProviderHealth";
import { Open, type OpenShape } from "./open";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import {
  WS_CHANNELS,
  WS_METHODS,
  type ServerProviderStatus,
  type WebSocketResponse,
  type WsPush,
} from "@t3tools/contracts";

interface PendingMessages {
  queue: unknown[];
  waiters: Array<(message: unknown) => void>;
}

const pendingBySocket = new WeakMap<WebSocket, PendingMessages>();
const tempDirs: string[] = [];
const connections: WebSocket[] = [];

const defaultOpenService: OpenShape = {
  openBrowser: () => Effect.void,
  openInEditor: () => Effect.void,
};

const defaultProviderStatuses: ReadonlyArray<ServerProviderStatus> = [
  {
    provider: "codex",
    status: "ready",
    available: true,
    authStatus: "authenticated",
    checkedAt: "2026-01-01T00:00:00.000Z",
  },
];

const defaultProviderHealthService: ProviderHealthShape = {
  getStatuses: Effect.succeed(defaultProviderStatuses),
};

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function connectSecureWs(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://127.0.0.1:${port}/`, { rejectUnauthorized: false });
    const pending: PendingMessages = { queue: [], waiters: [] };
    pendingBySocket.set(ws, pending);

    ws.on("message", (raw) => {
      const parsed = JSON.parse(String(raw));
      const waiter = pending.waiters.shift();
      if (waiter) {
        waiter(parsed);
        return;
      }
      pending.queue.push(parsed);
    });

    ws.once("open", () => resolve(ws));
    ws.once("error", () => reject(new Error("Secure WebSocket connection failed")));
  });
}

function waitForMessage(ws: WebSocket): Promise<unknown> {
  const pending = pendingBySocket.get(ws);
  if (!pending) {
    return Promise.reject(new Error("WebSocket not initialized"));
  }

  const queued = pending.queue.shift();
  if (queued !== undefined) {
    return Promise.resolve(queued);
  }

  return new Promise((resolve) => {
    pending.waiters.push(resolve);
  });
}

function asWebSocketResponse(message: unknown): WebSocketResponse | null {
  if (typeof message !== "object" || message === null) return null;
  if (!("id" in message)) return null;
  const id = (message as { id?: unknown }).id;
  if (typeof id !== "string") return null;
  return message as WebSocketResponse;
}

async function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<WebSocketResponse> {
  const id = crypto.randomUUID();
  const body =
    params && typeof params === "object" && !Array.isArray(params)
      ? { _tag: method, ...(params as Record<string, unknown>) }
      : { _tag: method };
  ws.send(JSON.stringify({ id, body }));

  while (true) {
    const parsed = asWebSocketResponse(await waitForMessage(ws));
    if (!parsed) {
      continue;
    }
    if (parsed.id === id || parsed.id === "unknown") {
      return parsed;
    }
  }
}

function inspectTlsFingerprint(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = TLS.connect(
      {
        host: "127.0.0.1",
        port,
        servername: "localhost",
        rejectUnauthorized: false,
      },
      () => {
        try {
          const certificate = socket.getPeerCertificate(true);
          if (typeof certificate.fingerprint256 !== "string" || certificate.fingerprint256.length === 0) {
            throw new Error("Missing TLS fingerprint.");
          }
          resolve(certificate.fingerprint256);
        } catch (error) {
          reject(error instanceof Error ? error : new Error(String(error)));
        } finally {
          socket.end();
        }
      },
    );

    socket.once("error", (error: Error) => {
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });
}

describe("wsServer TLS rotation", () => {
  let server: Http.Server | null = null;
  let serverScope: Scope.Closeable | null = null;

  async function createTestServer(): Promise<Http.Server> {
    const stateDir = makeTempDir("t3code-ws-tls-rotate-");
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const serverConfigLayer = Layer.succeed(ServerConfig, {
      mode: "web",
      port: 0,
      host: undefined,
      cwd: "/secure/workspace",
      keybindingsConfigPath: path.join(stateDir, "keybindings.json"),
      stateDir,
      staticDir: undefined,
      devUrl: undefined,
      noBrowser: true,
      authToken: undefined,
      tls: true,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
    } satisfies ServerConfigShape);

    const infrastructureLayer = makeServerProviderLayer().pipe(
      Layer.provideMerge(SqlitePersistenceMemory as Layer.Layer<
        SqlClient.SqlClient,
        SqlError.SqlError | MigrationError | PlatformError.PlatformError
      >),
    );
    const runtimeLayer = Layer.merge(
      makeServerRuntimeServicesLayer().pipe(Layer.provide(infrastructureLayer)),
      infrastructureLayer,
    );
    const dependenciesLayer = Layer.empty.pipe(
      Layer.provideMerge(runtimeLayer),
      Layer.provideMerge(Layer.succeed(ProviderHealth, defaultProviderHealthService)),
      Layer.provideMerge(Layer.succeed(Open, defaultOpenService)),
      Layer.provideMerge(serverConfigLayer),
      Layer.provideMerge(AnalyticsService.layerTest),
      Layer.provideMerge(NodeServices.layer),
    );

    try {
      const runtimeServices = await Effect.runPromise(
        Layer.build(dependenciesLayer).pipe(Scope.provide(scope)),
      );
      const runtime = await Effect.runPromise(
        createServer().pipe(Effect.provide(runtimeServices), Scope.provide(scope)),
      );
      serverScope = scope;
      return runtime as Http.Server;
    } catch (error) {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      throw error;
    }
  }

  afterEach(async () => {
    for (const ws of connections.splice(0, connections.length)) {
      ws.close();
    }
    if (serverScope) {
      const scope = serverScope;
      serverScope = null;
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
    server = null;
    for (const dir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rotates the live workspace TLS certificate over RPC", async () => {
    server = await createTestServer();
    const addr = server.address();
    const port = typeof addr === "object" && addr !== null ? addr.port : 0;

    const initialFingerprint = await inspectTlsFingerprint(port);
    const ws = await connectSecureWs(port);
    connections.push(ws);

    const welcome = (await waitForMessage(ws)) as WsPush;
    expect(welcome.channel).toBe(WS_CHANNELS.serverWelcome);

    const initialConfig = await sendRequest(ws, WS_METHODS.serverGetConfig);
    expect(initialConfig.error).toBeUndefined();
    expect(
      (initialConfig.result as { workspaceAccess: { tls: { fingerprintSha256: string; mode: string } } })
        .workspaceAccess.tls,
    ).toEqual({
      mode: "self-signed",
      fingerprintSha256: initialFingerprint,
      validFrom: expect.any(String),
      validTo: expect.any(String),
    });

    const rotateResponse = await sendRequest(ws, WS_METHODS.serverRotateWorkspaceTlsCertificate);
    expect(rotateResponse.error).toBeUndefined();
    const rotatedTls = rotateResponse.result as {
      tls: { mode: string; fingerprintSha256: string; validFrom: string; validTo: string };
    };
    expect(rotatedTls.tls.mode).toBe("self-signed");
    expect(rotatedTls.tls.fingerprintSha256).not.toBe(initialFingerprint);

    const rotatedFingerprint = await inspectTlsFingerprint(port);
    expect(rotatedFingerprint).toBe(rotatedTls.tls.fingerprintSha256);
  });
});
