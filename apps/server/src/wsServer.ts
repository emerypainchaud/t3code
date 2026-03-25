/**
 * Server - HTTP/WebSocket server service interface.
 *
 * Owns startup and shutdown lifecycle of the HTTP server, static asset serving,
 * and WebSocket request routing.
 *
 * @module Server
 */
import crypto from "node:crypto";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import type { Duplex } from "node:stream";

import Mime from "@effect/platform-node/Mime";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProjectExecutionTarget,
  ProjectId,
  type ServerWorkspaceAccess,
  ThreadId,
  TerminalEvent,
  WS_CHANNELS,
  WS_METHODS,
  WebSocketRequest,
  WsPush,
  type WsPushChannel,
  type WsPushData,
  WsResponse,
} from "@t3tools/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import {
  Cause,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Path,
  Ref,
  Schema,
  Scope,
  ServiceMap,
  Stream,
  Struct,
} from "effect";
import { WebSocketServer, type WebSocket } from "ws";

import { createLogger } from "./logger";
import { GitManager } from "./git/Services/GitManager.ts";
import { TerminalManager } from "./terminal/Services/Manager.ts";
import { Keybindings } from "./keybindings";
import {
  createWorkspaceDirectory,
  listWorkspaceDirectory,
  searchWorkspaceEntries,
} from "./workspaceEntries";
import { createSshDirectory, listSshDirectories, preflightSshTarget } from "./projectSsh.ts";
import { OrchestrationEngineService } from "./orchestration/Services/OrchestrationEngine";
import { ProjectionSnapshotQuery } from "./orchestration/Services/ProjectionSnapshotQuery";
import { OrchestrationReactor } from "./orchestration/Services/OrchestrationReactor";
import { ProviderService } from "./provider/Services/ProviderService";
import { ProviderHealth } from "./provider/Services/ProviderHealth";
import { CheckpointDiffQuery } from "./checkpointing/Services/CheckpointDiffQuery";
import { clamp } from "effect/Number";
import { Open, resolveAvailableEditors } from "./open";
import { ServerConfig } from "./config";
import { GitCore } from "./git/Services/GitCore.ts";
import { tryHandleProjectFaviconRequest } from "./projectFaviconRoute";
import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths";
import {
  createAttachmentId,
  resolveAttachmentPath,
  resolveAttachmentPathById,
} from "./attachmentStore.ts";
import { parseBase64DataUrl } from "./imageMime.ts";
import { AnalyticsService } from "./telemetry/Services/AnalyticsService.ts";
import { expandHomePath } from "./os-jank.ts";
import { resolveServerTlsConfig, rotateServerTlsConfig } from "./serverTls.ts";
import { RemoteExecutionManager } from "./remoteExecutionManager.ts";
import { resolveTerminalLaunchInput } from "./terminalLaunch.ts";

/**
 * ServerShape - Service API for server lifecycle control.
 */
export interface ServerShape {
  /**
   * Start HTTP and WebSocket listeners.
   */
  readonly start: Effect.Effect<
    http.Server | https.Server,
    ServerLifecycleError,
    Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >;

  /**
   * Wait for process shutdown signals.
   */
  readonly stopSignal: Effect.Effect<void, never>;
}

/**
 * Server - Service tag for HTTP/WebSocket lifecycle management.
 */
export class Server extends ServiceMap.Service<Server, ServerShape>()("t3/wsServer/Server") {}
const WS_CLIENT_PROTOCOL = "t3code.v1";
const WS_AUTH_PROTOCOL_PREFIX = "t3code.auth.";
const WORKSPACE_ACCESS_TOKEN_FILENAME = "workspace-access-token.txt";

const isServerNotRunningError = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  const maybeCode = (error as NodeJS.ErrnoException).code;
  return (
    maybeCode === "ERR_SERVER_NOT_RUNNING" || error.message.toLowerCase().includes("not running")
  );
};

function rejectUpgrade(socket: Duplex, statusCode: number, message: string): void {
  socket.end(
    `HTTP/1.1 ${statusCode} ${statusCode === 401 ? "Unauthorized" : "Bad Request"}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(message)}\r\n` +
      "\r\n" +
      message,
  );
}

function decodeAuthTokenProtocol(protocol: string): string | null {
  if (!protocol.startsWith(WS_AUTH_PROTOCOL_PREFIX)) {
    return null;
  }

  const encoded = protocol.slice(WS_AUTH_PROTOCOL_PREFIX.length);
  if (encoded.length === 0) {
    return null;
  }

  try {
    return Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
}

function resolveProvidedAuthToken(request: http.IncomingMessage, port: number): string | null {
  const protocolHeader = request.headers["sec-websocket-protocol"];
  const protocolValues = Array.isArray(protocolHeader)
    ? protocolHeader
    : typeof protocolHeader === "string"
      ? protocolHeader.split(",")
      : [];
  for (const protocol of protocolValues) {
    const decoded = decodeAuthTokenProtocol(protocol.trim());
    if (decoded !== null) {
      return decoded;
    }
  }

  try {
    const url = new URL(request.url ?? "/", `http://localhost:${port}`);
    return url.searchParams.get("token");
  } catch {
    return null;
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) {
    return false;
  }

  const normalized = address.trim();
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1" ||
    normalized.startsWith("::ffff:127.")
  );
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function collectWorkspaceAccessEndpoints(params: {
  host: string | undefined;
  port: number;
  tls: boolean;
}): ServerWorkspaceAccess["endpoints"] {
  const endpoints: Array<ServerWorkspaceAccess["endpoints"][number]> = [];
  const seen = new Set<string>();
  const protocol = params.tls ? "wss" : "ws";

  const pushEndpoint = (
    label: string,
    host: string,
    scope: ServerWorkspaceAccess["endpoints"][number]["scope"],
  ) => {
    const wsUrl = `${protocol}://${host.includes(":") && !host.startsWith("[") ? `[${host}]` : host}:${params.port}`;
    if (seen.has(wsUrl)) {
      return;
    }
    seen.add(wsUrl);
    endpoints.push({ label, wsUrl, scope });
  };

  pushEndpoint("Localhost", "localhost", "local");

  const host = params.host?.trim();
  if (host && host !== "0.0.0.0" && host !== "::" && host !== "[::]") {
    if (!isLoopbackHost(host)) {
      pushEndpoint(host, host, "public");
    }
    return endpoints;
  }

  const interfaces = os.networkInterfaces();
  for (const [name, addresses] of Object.entries(interfaces)) {
    for (const address of addresses ?? []) {
      if (address.internal || address.family !== "IPv4") {
        continue;
      }
      pushEndpoint(`${name}: ${address.address}`, address.address, "lan");
    }
  }

  return endpoints;
}

function websocketRawToString(raw: unknown): string | null {
  if (typeof raw === "string") {
    return raw;
  }
  if (raw instanceof Uint8Array) {
    return Buffer.from(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(new Uint8Array(raw)).toString("utf8");
  }
  if (Array.isArray(raw)) {
    const chunks: string[] = [];
    for (const chunk of raw) {
      if (typeof chunk === "string") {
        chunks.push(chunk);
        continue;
      }
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk).toString("utf8"));
        continue;
      }
      if (chunk instanceof ArrayBuffer) {
        chunks.push(Buffer.from(new Uint8Array(chunk)).toString("utf8"));
        continue;
      }
      return null;
    }
    return chunks.join("");
  }
  return null;
}

function toPosixRelativePath(input: string): string {
  return input.replaceAll("\\", "/");
}

function resolveWorkspaceWritePath(params: {
  workspaceRoot: string;
  relativePath: string;
  path: Path.Path;
}): Effect.Effect<{ absolutePath: string; relativePath: string }, RouteRequestError> {
  const normalizedInputPath = params.relativePath.trim();
  if (params.path.isAbsolute(normalizedInputPath)) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must be relative to the project root.",
      }),
    );
  }

  const absolutePath = params.path.resolve(params.workspaceRoot, normalizedInputPath);
  const relativeToRoot = toPosixRelativePath(
    params.path.relative(params.workspaceRoot, absolutePath),
  );
  if (
    relativeToRoot.length === 0 ||
    relativeToRoot === "." ||
    relativeToRoot.startsWith("../") ||
    relativeToRoot === ".." ||
    params.path.isAbsolute(relativeToRoot)
  ) {
    return Effect.fail(
      new RouteRequestError({
        message: "Workspace file path must stay within the project root.",
      }),
    );
  }

  return Effect.succeed({
    absolutePath,
    relativePath: relativeToRoot,
  });
}

function stripRequestTag<T extends { _tag: string }>(body: T) {
  return Struct.omit(body, ["_tag"]);
}

function messageFromCause(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause);
  const message = squashed instanceof Error ? squashed.message.trim() : String(squashed).trim();
  return message.length > 0 ? message : Cause.pretty(cause);
}

export type ServerCoreRuntimeServices =
  | OrchestrationEngineService
  | ProjectionSnapshotQuery
  | CheckpointDiffQuery
  | OrchestrationReactor
  | ProviderService
  | ProviderHealth;

export type ServerRuntimeServices =
  | ServerCoreRuntimeServices
  | GitManager
  | GitCore
  | TerminalManager
  | RemoteExecutionManager
  | Keybindings
  | Open
  | AnalyticsService;

export class ServerLifecycleError extends Schema.TaggedErrorClass<ServerLifecycleError>()(
  "ServerLifecycleError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

class RouteRequestError extends Schema.TaggedErrorClass<RouteRequestError>()("RouteRequestError", {
  message: Schema.String,
}) {}

export const createServer = Effect.fn(function* (): Effect.fn.Return<
  http.Server | https.Server,
  ServerLifecycleError,
  Scope.Scope | ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
> {
  const serverConfig = yield* ServerConfig;
  const {
    port,
    cwd,
    keybindingsConfigPath,
    staticDir,
    devUrl,
    authToken,
    host,
    tls,
    logWebSocketEvents,
    autoBootstrapProjectFromCwd,
  } = serverConfig;
  const availableEditors = resolveAvailableEditors();

  const gitManager = yield* GitManager;
  const terminalManager = yield* TerminalManager;
  const remoteExecutionManager = yield* RemoteExecutionManager;
  const keybindingsManager = yield* Keybindings;
  const providerHealth = yield* ProviderHealth;
  const git = yield* GitCore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tlsConfig = yield* resolveServerTlsConfig({
    enabled: tls,
    stateDir: serverConfig.stateDir,
    host,
  }).pipe(
    Effect.mapError(
      (cause) => new ServerLifecycleError({ operation: "resolveServerTlsConfig", cause }),
    ),
  );

  yield* keybindingsManager.syncDefaultKeybindingsOnStartup.pipe(
    Effect.catch((error) =>
      Effect.logWarning("failed to sync keybindings defaults on startup", {
        path: error.configPath,
        detail: error.detail,
        cause: error.cause,
      }),
    ),
  );

  const providerStatuses = yield* providerHealth.getStatuses;
  let listeningPort = port;
  let workspaceTlsState: ServerWorkspaceAccess["tls"] = tlsConfig?.workspaceTls ?? {
    mode: "disabled",
  };
  let currentTlsOptions = tlsConfig?.httpsOptions ?? null;
  let networkServer: http.Server | https.Server | null = null;
  const workspaceAccessTokenPath = path.join(
    serverConfig.stateDir,
    WORKSPACE_ACCESS_TOKEN_FILENAME,
  );
  const persistWorkspaceAccessToken = (token: string) =>
    fileSystem.writeFileString(workspaceAccessTokenPath, `${token}\n`).pipe(
      Effect.mapError(
        (cause) =>
          new ServerLifecycleError({
            operation: "persistWorkspaceAccessToken",
            cause,
          }),
      ),
    );
  const resolvePersistedWorkspaceAccessToken = Effect.fnUntraced(function* () {
    const existingToken = authToken?.trim();
    if (existingToken && existingToken.length > 0) {
      return {
        token: existingToken,
        tokenSource: "configured" as const,
      };
    }

    const persistedToken = yield* fileSystem
      .readFileString(workspaceAccessTokenPath)
      .pipe(Effect.catch(() => Effect.succeed("")));
    const normalizedPersistedToken = persistedToken.trim();
    if (normalizedPersistedToken.length > 0) {
      return {
        token: normalizedPersistedToken,
        tokenSource: "generated" as const,
      };
    }

    const generatedToken = crypto.randomBytes(24).toString("hex");
    yield* fileSystem
      .makeDirectory(serverConfig.stateDir, { recursive: true })
      .pipe(Effect.catch(() => Effect.void));
    yield* persistWorkspaceAccessToken(generatedToken);
    return {
      token: generatedToken,
      tokenSource: "generated" as const,
    };
  });

  let workspaceAccessTokenState = yield* resolvePersistedWorkspaceAccessToken();

  const buildWorkspaceAccess = (): ServerWorkspaceAccess => ({
    token: workspaceAccessTokenState.token,
    tokenSource: workspaceAccessTokenState.tokenSource,
    loopbackBypassEnabled: workspaceAccessTokenState.tokenSource === "generated",
    endpoints: collectWorkspaceAccessEndpoints({ host, port: listeningPort, tls }),
    tls: workspaceTlsState,
  });

  const rotateWorkspaceAccessToken = Effect.fnUntraced(function* () {
    if (workspaceAccessTokenState.tokenSource === "configured") {
      return yield* new RouteRequestError({
        message:
          "Workspace key is controlled by T3CODE_AUTH_TOKEN or --auth-token and cannot be rotated here.",
      });
    }

    const nextToken = crypto.randomBytes(24).toString("hex");
    yield* persistWorkspaceAccessToken(nextToken).pipe(
      Effect.mapError(
        () =>
          new RouteRequestError({
            message: "Unable to persist rotated workspace key.",
          }),
      ),
    );
    workspaceAccessTokenState = {
      token: nextToken,
      tokenSource: "generated",
    };
    return buildWorkspaceAccess();
  });

  const rotateWorkspaceTlsCertificate = Effect.fnUntraced(function* () {
    if (!tls) {
      return yield* new RouteRequestError({
        message: "TLS is disabled for this server.",
      });
    }

    const nextTlsConfig = yield* rotateServerTlsConfig({
      enabled: true,
      stateDir: serverConfig.stateDir,
      host,
    }).pipe(
      Effect.mapError(
        () =>
          new RouteRequestError({
            message: "Unable to rotate the workspace TLS certificate.",
          }),
      ),
    );
    if (!nextTlsConfig) {
      return yield* new RouteRequestError({
        message: "TLS is disabled for this server.",
      });
    }

    workspaceTlsState = nextTlsConfig.workspaceTls;
    currentTlsOptions = nextTlsConfig.httpsOptions;

    if (
      networkServer &&
      "setSecureContext" in networkServer &&
      typeof networkServer.setSecureContext === "function"
    ) {
      networkServer.setSecureContext(nextTlsConfig.httpsOptions);
    }

    return buildWorkspaceAccess();
  });

  const clients = yield* Ref.make(new Set<WebSocket>());
  const nextPushSequence = yield* Ref.make(0);
  const logger = createLogger("ws");

  function logOutgoingPush(push: WsPush, recipients: number) {
    if (!logWebSocketEvents) return;
    logger.event("outgoing push", {
      channel: push.channel,
      recipients,
      payload: push.data,
    });
  }

  const encodePush = Schema.encodeEffect(Schema.fromJsonString(WsPush));
  const sendPush = Effect.fnUntraced(function* <C extends WsPushChannel>(
    channel: C,
    data: WsPushData<C>,
    client?: WebSocket,
  ) {
    const push = {
      type: "push" as const,
      sequence: yield* Ref.updateAndGet(nextPushSequence, (sequence) => sequence + 1),
      channel,
      data,
    } as WsPush;
    const message = yield* encodePush(push);
    let recipients = 0;
    const targets = client ? [client] : Array.from(yield* Ref.get(clients));
    for (const target of targets) {
      if (target.readyState === target.OPEN) {
        target.send(message);
        recipients += 1;
      }
    }
    logOutgoingPush(push, recipients);
  });

  const onTerminalEvent = Effect.fnUntraced(function* (event: TerminalEvent) {
    yield* sendPush(WS_CHANNELS.terminalEvent, event);
  });

  const normalizeDispatchCommand = Effect.fnUntraced(function* (input: {
    readonly command: ClientOrchestrationCommand;
  }) {
    const normalizeExecutionTarget = Effect.fnUntraced(function* (
      executionTarget: ProjectExecutionTarget,
    ) {
      if (executionTarget.kind === "workspace-local") {
        return executionTarget;
      }

      return {
        ...executionTarget,
        label: executionTarget.label?.trim() || undefined,
        host: executionTarget.host.trim(),
        username: executionTarget.username?.trim() || undefined,
        remotePath: executionTarget.remotePath.trim(),
        sync: {
          ...executionTarget.sync,
          localPath: path.resolve(yield* expandHomePath(executionTarget.sync.localPath.trim())),
          ignores: executionTarget.sync.ignores
            .map((entry: string) => entry.trim())
            .filter(Boolean),
        },
      } satisfies ProjectExecutionTarget;
    });

    const normalizeProjectWorkspaceRoot = Effect.fnUntraced(function* (workspaceRoot: string) {
      const normalizedWorkspaceRoot = path.resolve(yield* expandHomePath(workspaceRoot.trim()));
      const workspaceStat = yield* fileSystem
        .stat(normalizedWorkspaceRoot)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (!workspaceStat) {
        return yield* new RouteRequestError({
          message: `Project directory does not exist: ${normalizedWorkspaceRoot}`,
        });
      }
      if (workspaceStat.type !== "Directory") {
        return yield* new RouteRequestError({
          message: `Project path is not a directory: ${normalizedWorkspaceRoot}`,
        });
      }
      return normalizedWorkspaceRoot;
    });

    if (input.command.type === "project.create") {
      return {
        ...input.command,
        workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot),
        ...(input.command.executionTarget !== undefined
          ? { executionTarget: yield* normalizeExecutionTarget(input.command.executionTarget) }
          : {}),
      } satisfies OrchestrationCommand;
    }

    if (
      input.command.type === "project.meta.update" &&
      (input.command.workspaceRoot !== undefined || input.command.executionTarget !== undefined)
    ) {
      return {
        ...input.command,
        ...(input.command.workspaceRoot !== undefined
          ? { workspaceRoot: yield* normalizeProjectWorkspaceRoot(input.command.workspaceRoot) }
          : {}),
        ...(input.command.executionTarget !== undefined
          ? { executionTarget: yield* normalizeExecutionTarget(input.command.executionTarget) }
          : {}),
      } satisfies OrchestrationCommand;
    }

    if (input.command.type !== "thread.turn.start") {
      return input.command as OrchestrationCommand;
    }
    const turnStartCommand = input.command;

    const normalizedAttachments = yield* Effect.forEach(
      turnStartCommand.message.attachments,
      (attachment) =>
        Effect.gen(function* () {
          const parsed = parseBase64DataUrl(attachment.dataUrl);
          if (!parsed || !parsed.mimeType.startsWith("image/")) {
            return yield* new RouteRequestError({
              message: `Invalid image attachment payload for '${attachment.name}'.`,
            });
          }

          const bytes = Buffer.from(parsed.base64, "base64");
          if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
            return yield* new RouteRequestError({
              message: `Image attachment '${attachment.name}' is empty or too large.`,
            });
          }

          const attachmentId = createAttachmentId(turnStartCommand.threadId);
          if (!attachmentId) {
            return yield* new RouteRequestError({
              message: "Failed to create a safe attachment id.",
            });
          }

          const persistedAttachment = {
            type: "image" as const,
            id: attachmentId,
            name: attachment.name,
            mimeType: parsed.mimeType.toLowerCase(),
            sizeBytes: bytes.byteLength,
          };

          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: serverConfig.attachmentsDir,
            attachment: persistedAttachment,
          });
          if (!attachmentPath) {
            return yield* new RouteRequestError({
              message: `Failed to resolve persisted path for '${attachment.name}'.`,
            });
          }

          yield* fileSystem.makeDirectory(path.dirname(attachmentPath), { recursive: true }).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to create attachment directory for '${attachment.name}'.`,
                }),
            ),
          );
          yield* fileSystem.writeFile(attachmentPath, bytes).pipe(
            Effect.mapError(
              () =>
                new RouteRequestError({
                  message: `Failed to persist attachment '${attachment.name}'.`,
                }),
            ),
          );

          return persistedAttachment;
        }),
      { concurrency: 1 },
    );

    return {
      ...turnStartCommand,
      message: {
        ...turnStartCommand.message,
        attachments: normalizedAttachments,
      },
    } satisfies OrchestrationCommand;
  });

  // HTTP server — serves static files or redirects to Vite dev server
  const handleHttpRequest = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const respond = (
      statusCode: number,
      headers: Record<string, string>,
      body?: string | Uint8Array,
    ) => {
      res.writeHead(statusCode, headers);
      res.end(body);
    };

    void Effect.runPromise(
      Effect.gen(function* () {
        const url = new URL(req.url ?? "/", `${tls ? "https" : "http"}://localhost:${port}`);
        if (tryHandleProjectFaviconRequest(url, res)) {
          return;
        }

        if (url.pathname.startsWith(ATTACHMENTS_ROUTE_PREFIX)) {
          const rawRelativePath = url.pathname.slice(ATTACHMENTS_ROUTE_PREFIX.length);
          const normalizedRelativePath = normalizeAttachmentRelativePath(rawRelativePath);
          if (!normalizedRelativePath) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid attachment path");
            return;
          }

          const isIdLookup =
            !normalizedRelativePath.includes("/") && !normalizedRelativePath.includes(".");
          const filePath = isIdLookup
            ? resolveAttachmentPathById({
                attachmentsDir: serverConfig.attachmentsDir,
                attachmentId: normalizedRelativePath,
              })
            : resolveAttachmentRelativePath({
                attachmentsDir: serverConfig.attachmentsDir,
                relativePath: normalizedRelativePath,
              });
          if (!filePath) {
            respond(
              isIdLookup ? 404 : 400,
              { "Content-Type": "text/plain" },
              isIdLookup ? "Not Found" : "Invalid attachment path",
            );
            return;
          }

          const fileInfo = yield* fileSystem
            .stat(filePath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!fileInfo || fileInfo.type !== "File") {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }

          const contentType = Mime.getType(filePath) ?? "application/octet-stream";
          res.writeHead(200, {
            "Content-Type": contentType,
            "Cache-Control": "public, max-age=31536000, immutable",
          });
          const streamExit = yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
            Effect.sync(() => {
              if (!res.destroyed) {
                res.write(chunk);
              }
            }),
          ).pipe(Effect.exit);
          if (streamExit._tag === "Failure") {
            if (!res.destroyed) {
              res.destroy();
            }
            return;
          }
          if (!res.writableEnded) {
            res.end();
          }
          return;
        }

        if (devUrl) {
          respond(302, { Location: devUrl.href });
          return;
        }

        if (!staticDir) {
          respond(
            503,
            { "Content-Type": "text/plain" },
            "No static directory configured and no dev URL set.",
          );
          return;
        }

        const staticRoot = path.resolve(staticDir);
        const staticRequestPath = url.pathname === "/" ? "/index.html" : url.pathname;
        const rawStaticRelativePath = staticRequestPath.replace(/^[/\\]+/, "");
        const hasRawLeadingParentSegment = rawStaticRelativePath.startsWith("..");
        const staticRelativePath = path.normalize(rawStaticRelativePath).replace(/^[/\\]+/, "");
        const hasPathTraversalSegment = staticRelativePath.startsWith("..");
        if (
          staticRelativePath.length === 0 ||
          hasRawLeadingParentSegment ||
          hasPathTraversalSegment ||
          staticRelativePath.includes("\0")
        ) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const isWithinStaticRoot = (candidate: string) =>
          candidate === staticRoot ||
          candidate.startsWith(
            staticRoot.endsWith(path.sep) ? staticRoot : `${staticRoot}${path.sep}`,
          );

        let filePath = path.resolve(staticRoot, staticRelativePath);
        if (!isWithinStaticRoot(filePath)) {
          respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
          return;
        }

        const ext = path.extname(filePath);
        if (!ext) {
          filePath = path.resolve(filePath, "index.html");
          if (!isWithinStaticRoot(filePath)) {
            respond(400, { "Content-Type": "text/plain" }, "Invalid static file path");
            return;
          }
        }

        const fileInfo = yield* fileSystem
          .stat(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!fileInfo || fileInfo.type !== "File") {
          const indexPath = path.resolve(staticRoot, "index.html");
          const indexData = yield* fileSystem
            .readFile(indexPath)
            .pipe(Effect.catch(() => Effect.succeed(null)));
          if (!indexData) {
            respond(404, { "Content-Type": "text/plain" }, "Not Found");
            return;
          }
          respond(200, { "Content-Type": "text/html; charset=utf-8" }, indexData);
          return;
        }

        const contentType = Mime.getType(filePath) ?? "application/octet-stream";
        const data = yield* fileSystem
          .readFile(filePath)
          .pipe(Effect.catch(() => Effect.succeed(null)));
        if (!data) {
          respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
          return;
        }
        respond(200, { "Content-Type": contentType }, data);
      }),
    ).catch(() => {
      if (!res.headersSent) {
        respond(500, { "Content-Type": "text/plain" }, "Internal Server Error");
      }
    });
  };

  networkServer = (
    currentTlsOptions
      ? https.createServer(currentTlsOptions, handleHttpRequest)
      : http.createServer(handleHttpRequest)
  ) as http.Server | https.Server;

  // WebSocket server — upgrades from the HTTP server
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => {
      if (protocols.has(WS_CLIENT_PROTOCOL)) {
        return WS_CLIENT_PROTOCOL;
      }
      return false;
    },
  });

  const closeWebSocketServer = Effect.callback<void, ServerLifecycleError>((resume) => {
    wss.close((error) => {
      if (error && !isServerNotRunningError(error)) {
        resume(
          Effect.fail(
            new ServerLifecycleError({ operation: "closeWebSocketServer", cause: error }),
          ),
        );
      } else {
        resume(Effect.void);
      }
    });
  });

  const closeAllClients = Ref.get(clients).pipe(
    Effect.flatMap(Effect.forEach((client) => Effect.sync(() => client.close()))),
    Effect.flatMap(() => Ref.set(clients, new Set())),
  );

  const listenOptions = host ? { host, port } : { port };

  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionReadModelQuery = yield* ProjectionSnapshotQuery;
  const checkpointDiffQuery = yield* CheckpointDiffQuery;
  const orchestrationReactor = yield* OrchestrationReactor;
  const { openInEditor } = yield* Open;

  const subscriptionsScope = yield* Scope.make("sequential");
  yield* Effect.addFinalizer(() => Scope.close(subscriptionsScope, Exit.void));

  yield* Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
    sendPush(ORCHESTRATION_WS_CHANNELS.domainEvent, event),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Stream.runForEach(keybindingsManager.streamChanges, (event) =>
    sendPush(WS_CHANNELS.serverConfigUpdated, {
      issues: event.issues,
      providers: providerStatuses,
    }),
  ).pipe(Effect.forkIn(subscriptionsScope));

  yield* Scope.provide(orchestrationReactor.start, subscriptionsScope);

  let welcomeBootstrapProjectId: ProjectId | undefined;
  let welcomeBootstrapThreadId: ThreadId | undefined;

  if (autoBootstrapProjectFromCwd) {
    yield* Effect.gen(function* () {
      const snapshot = yield* projectionReadModelQuery.getSnapshot();
      const existingProject = snapshot.projects.find(
        (project) => project.workspaceRoot === cwd && project.deletedAt === null,
      );
      let bootstrapProjectId: ProjectId;
      let bootstrapProjectDefaultModel: string;

      if (!existingProject) {
        const createdAt = new Date().toISOString();
        bootstrapProjectId = ProjectId.makeUnsafe(crypto.randomUUID());
        const bootstrapProjectTitle = path.basename(cwd) || "project";
        bootstrapProjectDefaultModel = "gpt-5-codex";
        yield* orchestrationEngine.dispatch({
          type: "project.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          projectId: bootstrapProjectId,
          title: bootstrapProjectTitle,
          workspaceRoot: cwd,
          defaultModel: bootstrapProjectDefaultModel,
          createdAt,
        });
      } else {
        bootstrapProjectId = existingProject.id;
        bootstrapProjectDefaultModel = existingProject.defaultModel ?? "gpt-5-codex";
      }

      const existingThread = snapshot.threads.find(
        (thread) => thread.projectId === bootstrapProjectId && thread.deletedAt === null,
      );
      if (!existingThread) {
        const createdAt = new Date().toISOString();
        const threadId = ThreadId.makeUnsafe(crypto.randomUUID());
        yield* orchestrationEngine.dispatch({
          type: "thread.create",
          commandId: CommandId.makeUnsafe(crypto.randomUUID()),
          threadId,
          projectId: bootstrapProjectId,
          title: "New thread",
          model: bootstrapProjectDefaultModel,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          runtimeMode: "full-access",
          branch: null,
          worktreePath: null,
          createdAt,
        });
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = threadId;
      } else {
        welcomeBootstrapProjectId = bootstrapProjectId;
        welcomeBootstrapThreadId = existingThread.id;
      }
    }).pipe(
      Effect.mapError(
        (cause) => new ServerLifecycleError({ operation: "autoBootstrapProject", cause }),
      ),
    );
  }

  const runtimeServices = yield* Effect.services<
    ServerRuntimeServices | ServerConfig | FileSystem.FileSystem | Path.Path
  >();
  const runPromise = Effect.runPromiseWith(runtimeServices);

  const unsubscribeTerminalEvents = yield* terminalManager.subscribe(
    (event) => void Effect.runPromise(onTerminalEvent(event)),
  );
  yield* Effect.addFinalizer(() => Effect.sync(() => unsubscribeTerminalEvents()));

  yield* NodeHttpServer.make(() => networkServer, listenOptions).pipe(
    Effect.mapError((cause) => new ServerLifecycleError({ operation: "httpServerListen", cause })),
  );
  const address = networkServer.address();
  listeningPort = typeof address === "object" && address !== null ? address.port : port;

  yield* Effect.addFinalizer(() =>
    Effect.all([
      closeAllClients,
      closeWebSocketServer.pipe(
        Effect.catch((error) =>
          Effect.logWarning("failed to close web socket server", { cause: error }),
        ),
      ),
    ]),
  );

  const routeRequest = Effect.fnUntraced(function* (request: WebSocketRequest) {
    switch (request.body._tag) {
      case ORCHESTRATION_WS_METHODS.getSnapshot:
        return yield* projectionReadModelQuery.getSnapshot();

      case ORCHESTRATION_WS_METHODS.dispatchCommand: {
        const { command } = request.body;
        const normalizedCommand = yield* normalizeDispatchCommand({ command });
        return yield* orchestrationEngine.dispatch(normalizedCommand);
      }

      case ORCHESTRATION_WS_METHODS.getTurnDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getTurnDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.getFullThreadDiff: {
        const body = stripRequestTag(request.body);
        return yield* checkpointDiffQuery.getFullThreadDiff(body);
      }

      case ORCHESTRATION_WS_METHODS.replayEvents: {
        const { fromSequenceExclusive } = request.body;
        return yield* Stream.runCollect(
          orchestrationEngine.readEvents(
            clamp(fromSequenceExclusive, {
              maximum: Number.MAX_SAFE_INTEGER,
              minimum: 0,
            }),
          ),
        ).pipe(Effect.map((events) => Array.from(events)));
      }

      case WS_METHODS.projectsSearchEntries: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => searchWorkspaceEntries(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to search workspace entries: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsListDirectory: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => listWorkspaceDirectory(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to list workspace directory: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsCreateDirectory: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => createWorkspaceDirectory(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to create workspace directory: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsSshListDirectory: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => listSshDirectories(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to list SSH target directory: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsSshCreateDirectory: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => createSshDirectory(body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to create SSH target directory: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsSshPreflight: {
        const body = stripRequestTag(request.body);
        return yield* Effect.tryPromise({
          try: () => preflightSshTarget(serverConfig.stateDir, body),
          catch: (cause) =>
            new RouteRequestError({
              message: `Failed to validate SSH target: ${String(cause)}`,
            }),
        });
      }

      case WS_METHODS.projectsWriteFile: {
        const body = stripRequestTag(request.body);
        const target = yield* resolveWorkspaceWritePath({
          workspaceRoot: body.cwd,
          relativePath: body.relativePath,
          path,
        });
        yield* fileSystem
          .makeDirectory(path.dirname(target.absolutePath), { recursive: true })
          .pipe(
            Effect.mapError(
              (cause) =>
                new RouteRequestError({
                  message: `Failed to prepare workspace path: ${String(cause)}`,
                }),
            ),
          );
        yield* fileSystem.writeFileString(target.absolutePath, body.contents).pipe(
          Effect.mapError(
            (cause) =>
              new RouteRequestError({
                message: `Failed to write workspace file: ${String(cause)}`,
              }),
          ),
        );
        return { relativePath: target.relativePath };
      }

      case WS_METHODS.shellOpenInEditor: {
        const body = stripRequestTag(request.body);
        return yield* openInEditor(body);
      }

      case WS_METHODS.gitStatus: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.status(body);
      }

      case WS_METHODS.gitPull: {
        const body = stripRequestTag(request.body);
        return yield* git.pullCurrentBranch(body.cwd);
      }

      case WS_METHODS.gitRunStackedAction: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.runStackedAction(body);
      }

      case WS_METHODS.gitResolvePullRequest: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.resolvePullRequest(body);
      }

      case WS_METHODS.gitPreparePullRequestThread: {
        const body = stripRequestTag(request.body);
        return yield* gitManager.preparePullRequestThread(body);
      }

      case WS_METHODS.gitListBranches: {
        const body = stripRequestTag(request.body);
        return yield* git.listBranches(body);
      }

      case WS_METHODS.gitCreateWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.createWorktree(body);
      }

      case WS_METHODS.gitRemoveWorktree: {
        const body = stripRequestTag(request.body);
        return yield* git.removeWorktree(body);
      }

      case WS_METHODS.gitCreateBranch: {
        const body = stripRequestTag(request.body);
        return yield* git.createBranch(body);
      }

      case WS_METHODS.gitCheckout: {
        const body = stripRequestTag(request.body);
        return yield* Effect.scoped(git.checkoutBranch(body));
      }

      case WS_METHODS.gitInit: {
        const body = stripRequestTag(request.body);
        return yield* git.initRepo(body);
      }

      case WS_METHODS.terminalOpen: {
        const body = stripRequestTag(request.body);
        const snapshot = yield* projectionReadModelQuery.getSnapshot();
        const resolved = yield* resolveTerminalLaunchInput({
          request: body,
          snapshot,
          remoteExecution: remoteExecutionManager,
        }).pipe(
          Effect.catchTag("TerminalLaunchResolutionError", (error) =>
            Effect.fail(
              new RouteRequestError({
                message: error.message,
              }),
            ),
          ),
        );
        return yield* terminalManager.open({
          ...body,
          cwd: resolved.cwd,
          ...(resolved.env ? { env: resolved.env } : {}),
        });
      }

      case WS_METHODS.terminalWrite: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.write(body);
      }

      case WS_METHODS.terminalResize: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.resize(body);
      }

      case WS_METHODS.terminalClear: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.clear(body);
      }

      case WS_METHODS.terminalRestart: {
        const body = stripRequestTag(request.body);
        const snapshot = yield* projectionReadModelQuery.getSnapshot();
        const resolved = yield* resolveTerminalLaunchInput({
          request: body,
          snapshot,
          remoteExecution: remoteExecutionManager,
        }).pipe(
          Effect.catchTag("TerminalLaunchResolutionError", (error) =>
            Effect.fail(
              new RouteRequestError({
                message: error.message,
              }),
            ),
          ),
        );
        return yield* terminalManager.restart({
          ...body,
          cwd: resolved.cwd,
          ...(resolved.env ? { env: resolved.env } : {}),
        });
      }

      case WS_METHODS.terminalClose: {
        const body = stripRequestTag(request.body);
        return yield* terminalManager.close(body);
      }

      case WS_METHODS.serverGetConfig:
        const keybindingsConfig = yield* keybindingsManager.loadConfigState;
        return {
          cwd,
          keybindingsConfigPath,
          keybindings: keybindingsConfig.keybindings,
          issues: keybindingsConfig.issues,
          providers: providerStatuses,
          availableEditors,
          workspaceAccess: buildWorkspaceAccess(),
        };

      case WS_METHODS.serverUpsertKeybinding: {
        const body = stripRequestTag(request.body);
        const keybindingsConfig = yield* keybindingsManager.upsertKeybindingRule(body);
        return { keybindings: keybindingsConfig, issues: [] };
      }

      case WS_METHODS.serverRotateWorkspaceAccessToken:
        return yield* rotateWorkspaceAccessToken();

      case WS_METHODS.serverRotateWorkspaceTlsCertificate:
        return yield* rotateWorkspaceTlsCertificate();

      default: {
        const _exhaustiveCheck: never = request.body;
        return yield* new RouteRequestError({
          message: `Unknown method: ${String(_exhaustiveCheck)}`,
        });
      }
    }
  });

  const handleMessage = Effect.fnUntraced(function* (ws: WebSocket, raw: unknown) {
    const encodeResponse = Schema.encodeEffect(Schema.fromJsonString(WsResponse));

    const messageText = websocketRawToString(raw);
    if (messageText === null) {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: "Invalid request format: Failed to read message" },
      });
      ws.send(errorResponse);
      return;
    }

    const request = Schema.decodeExit(Schema.fromJsonString(WebSocketRequest))(messageText);
    if (request._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: "unknown",
        error: { message: `Invalid request format: ${messageFromCause(request.cause)}` },
      });
      ws.send(errorResponse);
      return;
    }

    const result = yield* Effect.exit(routeRequest(request.value));
    if (result._tag === "Failure") {
      const errorResponse = yield* encodeResponse({
        id: request.value.id,
        error: { message: messageFromCause(result.cause) },
      });
      ws.send(errorResponse);
      return;
    }

    const response = yield* encodeResponse({
      id: request.value.id,
      result: result.value,
    });

    ws.send(response);
  });

  networkServer.on("upgrade", (request, socket, head) => {
    socket.on("error", () => {}); // Prevent unhandled `EPIPE`/`ECONNRESET` from crashing the process if the client disconnects mid-handshake

    const providedToken = resolveProvidedAuthToken(request, listeningPort);
    const loopbackBypassEnabled = workspaceAccessTokenState.tokenSource === "generated";
    const isLoopbackClient = isLoopbackAddress(request.socket.remoteAddress);
    if (
      providedToken !== workspaceAccessTokenState.token &&
      (!loopbackBypassEnabled || !isLoopbackClient)
    ) {
      rejectUpgrade(socket, 401, "Unauthorized WebSocket connection");
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (ws) => {
    void runPromise(Ref.update(clients, (clients) => clients.add(ws)));

    const segments = cwd.split(/[/\\]/).filter(Boolean);
    const projectName = segments[segments.length - 1] ?? "project";

    void runPromise(
      sendPush(
        WS_CHANNELS.serverWelcome,
        {
          cwd,
          projectName,
          ...(welcomeBootstrapProjectId ? { bootstrapProjectId: welcomeBootstrapProjectId } : {}),
          ...(welcomeBootstrapThreadId ? { bootstrapThreadId: welcomeBootstrapThreadId } : {}),
        },
        ws,
      ),
    );

    ws.on("message", (raw) => {
      void runPromise(
        handleMessage(ws, raw).pipe(
          Effect.catch((error) => Effect.logError("Error handling message", error)),
        ),
      );
    });

    ws.on("close", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });

    ws.on("error", () => {
      void runPromise(
        Ref.update(clients, (clients) => {
          clients.delete(ws);
          return clients;
        }),
      );
    });
  });

  return networkServer;
});

export const ServerLive = Layer.succeed(Server, {
  start: createServer(),
  stopSignal: Effect.never,
} satisfies ServerShape);
