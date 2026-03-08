import fs from "node:fs";

import type { ProjectExecutionTarget, ProviderSessionStartInput } from "@t3tools/contracts";
import { Effect, Layer, Schema, ServiceMap } from "effect";

import { ServerConfig } from "./config.ts";
import { runProcess, type ProcessRunResult } from "./processRunner.ts";
import {
  buildRemoteCodexProviderOptions,
  buildRemoteTerminalEnvironment,
  ensureRemoteShellScript,
  remoteExecutionMutagenLabelSelector,
} from "./remoteExecution.ts";

type ProcessRunner = (
  command: string,
  args: readonly string[],
  options?: {
    cwd?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    stdin?: string;
    allowNonZeroExit?: boolean;
    maxBufferBytes?: number;
    outputMode?: "error" | "truncate";
  },
) => Promise<ProcessRunResult>;

export const RemoteExecutionSyncStatus = Schema.Literals(["local", "ready", "error"]);
export type RemoteExecutionSyncStatus = typeof RemoteExecutionSyncStatus.Type;

export const RemoteExecutionSyncState = Schema.Struct({
  key: Schema.String,
  status: RemoteExecutionSyncStatus,
  updatedAt: Schema.String,
  detail: Schema.NullOr(Schema.String),
});
export type RemoteExecutionSyncState = typeof RemoteExecutionSyncState.Type;

export class RemoteExecutionError extends Schema.TaggedErrorClass<RemoteExecutionError>()(
  "RemoteExecutionError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

export interface RemoteExecutionLaunchConfig {
  readonly cwd: string | undefined;
  readonly terminalEnv: Record<string, string> | undefined;
  readonly providerOptions: ProviderSessionStartInput["providerOptions"] | undefined;
  readonly syncState: RemoteExecutionSyncState;
}

export interface RemoteExecutionManagerShape {
  readonly prepareLaunch: (
    input: {
      readonly cwd: string | undefined;
      readonly target: ProjectExecutionTarget;
    },
  ) => Effect.Effect<RemoteExecutionLaunchConfig, RemoteExecutionError>;
  readonly getSyncState: (
    target: ProjectExecutionTarget,
  ) => Effect.Effect<RemoteExecutionSyncState, never>;
}

export class RemoteExecutionManager extends ServiceMap.Service<
  RemoteExecutionManager,
  RemoteExecutionManagerShape
>()("t3/remoteExecutionManager") {}

function remoteExecutionStateKey(target: ProjectExecutionTarget): string {
  if (target.kind === "workspace-local") {
    return "workspace-local";
  }
  return remoteExecutionMutagenLabelSelector(target);
}

function nowIso(): string {
  return new Date().toISOString();
}

function createSyncArgs(target: Extract<ProjectExecutionTarget, { kind: "ssh" }>): string[] {
  const remoteHost =
    target.username && target.username.length > 0 ? `${target.username}@${target.host}` : target.host;
  const remoteEndpoint =
    target.port !== undefined
      ? `${remoteHost}:${target.port}:${target.remotePath}`
      : `${remoteHost}:${target.remotePath}`;
  const args = [
    "sync",
    "create",
    target.sync.localPath,
    remoteEndpoint,
    "--name",
    remoteExecutionStateKey(target).replace(/^t3-session=/, ""),
    "--label",
    "t3=true",
    "--label",
    remoteExecutionMutagenLabelSelector(target),
    "--sync-mode",
    "two-way-resolved",
    "--default-file-mode-beta",
    "0644",
    "--default-directory-mode-beta",
    "0755",
  ];
  for (const pattern of target.sync.ignores) {
    args.push("--ignore", pattern);
  }
  return args;
}

function flushSyncArgs(target: Extract<ProjectExecutionTarget, { kind: "ssh" }>): string[] {
  return ["sync", "flush", "--label-selector", remoteExecutionMutagenLabelSelector(target)];
}

function listSyncArgs(target: Extract<ProjectExecutionTarget, { kind: "ssh" }>): string[] {
  return ["sync", "list", "--label-selector", remoteExecutionMutagenLabelSelector(target)];
}

function hasExistingMutagenSession(result: ProcessRunResult): boolean {
  return result.code === 0 && result.stdout.includes("Name:");
}

export class RemoteExecutionManagerRuntime implements RemoteExecutionManagerShape {
  private readonly syncStates = new Map<string, RemoteExecutionSyncState>();

  constructor(
    private readonly stateDir: string,
    private readonly processRunner: ProcessRunner = runProcess,
  ) {}

  readonly getSyncState: RemoteExecutionManagerShape["getSyncState"] = (target) =>
    Effect.sync(() => {
      const key = remoteExecutionStateKey(target);
      return (
        this.syncStates.get(key) ?? {
          key,
          status: target.kind === "workspace-local" ? "local" : "error",
          updatedAt: nowIso(),
          detail: target.kind === "workspace-local" ? null : "Not initialized.",
        }
      );
    });

  readonly prepareLaunch: RemoteExecutionManagerShape["prepareLaunch"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        if (input.target.kind === "workspace-local") {
          const syncState: RemoteExecutionSyncState = {
            key: remoteExecutionStateKey(input.target),
            status: "local",
            updatedAt: nowIso(),
            detail: null,
          };
          this.syncStates.set(syncState.key, syncState);
          return {
            cwd: input.cwd,
            terminalEnv: undefined,
            providerOptions: undefined,
            syncState,
          } satisfies RemoteExecutionLaunchConfig;
        }

        const target = input.target;
        fs.mkdirSync(target.sync.localPath, { recursive: true });
        const shellPath = ensureRemoteShellScript(this.stateDir);
        const listResult = await this.processRunner("mutagen", listSyncArgs(target), {
          allowNonZeroExit: true,
          outputMode: "truncate",
          maxBufferBytes: 256 * 1024,
        });
        if (!hasExistingMutagenSession(listResult)) {
          await this.processRunner("mutagen", createSyncArgs(target), {
            outputMode: "truncate",
            maxBufferBytes: 256 * 1024,
          });
        }
        await this.processRunner("mutagen", flushSyncArgs(target), {
          outputMode: "truncate",
          maxBufferBytes: 256 * 1024,
        });

        const syncState: RemoteExecutionSyncState = {
          key: remoteExecutionStateKey(target),
          status: "ready",
          updatedAt: nowIso(),
          detail: null,
        };
        this.syncStates.set(syncState.key, syncState);
        return {
          cwd: input.cwd ?? target.sync.localPath,
          terminalEnv: {
            SHELL: shellPath,
            ...buildRemoteTerminalEnvironment({
              stateDir: this.stateDir,
              target,
            }),
          },
          providerOptions: buildRemoteCodexProviderOptions({
            stateDir: this.stateDir,
            target,
          }),
          syncState,
        } satisfies RemoteExecutionLaunchConfig;
      },
      catch: (cause) => {
        const key = remoteExecutionStateKey(input.target);
        const detail = cause instanceof Error ? cause.message : String(cause);
        this.syncStates.set(key, {
          key,
          status: "error",
          updatedAt: nowIso(),
          detail,
        });
        return new RemoteExecutionError({
          message:
            input.target.kind === "ssh"
              ? `Remote execution sync failed for ${input.target.host}: ${detail}`
              : detail,
          cause,
        });
      },
    });
}

export const RemoteExecutionManagerLive = Layer.effect(
  RemoteExecutionManager,
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    return new RemoteExecutionManagerRuntime(serverConfig.stateDir);
  }),
);
