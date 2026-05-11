import fs from "node:fs";

import type {
  ProjectExecutionTarget,
  ProviderDriverKind,
  ProviderSessionStartInput,
} from "@t3tools/contracts";
import { Context, Effect, Layer, Schema } from "effect";

import { ServerConfig } from "./config.ts";
import { ensureManagedMutagenBinary } from "./managedMutagen.ts";
import { type ProcessRunResult, runProcess } from "./processRunner.ts";
import {
  buildRemoteProviderOptions,
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
  readonly prepareLaunch: (input: {
    readonly cwd: string | undefined;
    readonly target: ProjectExecutionTarget;
    readonly provider?: ProviderDriverKind;
    readonly baseProviderOptions?: ProviderSessionStartInput["providerOptions"];
  }) => Effect.Effect<RemoteExecutionLaunchConfig, RemoteExecutionError>;
  readonly getSyncState: (
    target: ProjectExecutionTarget,
  ) => Effect.Effect<RemoteExecutionSyncState, never>;
}

export class RemoteExecutionManager extends Context.Service<
  RemoteExecutionManager,
  RemoteExecutionManagerShape
>()("t3/remoteExecutionManager") {}

const INITIAL_MUTAGEN_CREATE_TIMEOUT_MS = 10 * 60_000;
const INITIAL_MUTAGEN_FLUSH_TIMEOUT_MS = 10 * 60_000;
const REUSED_MUTAGEN_FLUSH_TIMEOUT_MS = 2 * 60_000;
const MUTAGEN_SYNC_READY_TIMEOUT_MS = 30_000;
const MUTAGEN_SYNC_READY_POLL_MS = 1_000;

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
    target.username && target.username.length > 0
      ? `${target.username}@${target.host}`
      : target.host;
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

function appearsSynchronizable(result: ProcessRunResult): boolean {
  const connectedMatches = result.stdout.match(/Connected:\s+Yes/g);
  return (
    result.code === 0 &&
    (connectedMatches?.length ?? 0) >= 2 &&
    /Status:\s+(Watching for changes|Scanning|Synchronizing|Staging files|Reconciling)/.test(
      result.stdout,
    )
  );
}

function isTransientMutagenFlushError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("unable to flush session: session is not currently able to synchronize") ||
    message.includes("unable to flush session") ||
    message.includes("timed out")
  );
}

class RemoteExecutionManagerRuntime implements RemoteExecutionManagerShape {
  private readonly syncStates = new Map<string, RemoteExecutionSyncState>();
  private readonly stateDir: string;
  private readonly processRunner: ProcessRunner;

  constructor(stateDir: string, processRunner: ProcessRunner = runProcess) {
    this.stateDir = stateDir;
    this.processRunner = processRunner;
  }

  private async waitForSynchronizableSession(
    mutagenCommand: string,
    target: Extract<ProjectExecutionTarget, { kind: "ssh" }>,
  ): Promise<void> {
    const deadline = Date.now() + MUTAGEN_SYNC_READY_TIMEOUT_MS;
    for (;;) {
      const listResult = await this.processRunner(mutagenCommand, listSyncArgs(target), {
        allowNonZeroExit: true,
        outputMode: "truncate",
        maxBufferBytes: 256 * 1024,
      });
      if (appearsSynchronizable(listResult)) {
        return;
      }
      if (Date.now() >= deadline) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, MUTAGEN_SYNC_READY_POLL_MS));
    }
  }

  private async flushSyncWithRecovery(input: {
    readonly mutagenCommand: string;
    readonly target: Extract<ProjectExecutionTarget, { kind: "ssh" }>;
    readonly timeoutMs: number;
  }): Promise<void> {
    try {
      await this.processRunner(input.mutagenCommand, flushSyncArgs(input.target), {
        outputMode: "truncate",
        timeoutMs: input.timeoutMs,
        maxBufferBytes: 256 * 1024,
      });
      return;
    } catch (error) {
      if (!isTransientMutagenFlushError(error)) {
        throw error;
      }
      await this.waitForSynchronizableSession(input.mutagenCommand, input.target);
      await this.processRunner(input.mutagenCommand, flushSyncArgs(input.target), {
        outputMode: "truncate",
        timeoutMs: input.timeoutMs,
        maxBufferBytes: 256 * 1024,
      });
    }
  }

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
        const mutagenCommand = await ensureManagedMutagenBinary(this.stateDir);
        const listResult = await this.processRunner(mutagenCommand, listSyncArgs(target), {
          allowNonZeroExit: true,
          outputMode: "truncate",
          maxBufferBytes: 256 * 1024,
        });
        const hasExistingSession = hasExistingMutagenSession(listResult);
        if (!hasExistingSession) {
          await this.processRunner(mutagenCommand, createSyncArgs(target), {
            outputMode: "truncate",
            timeoutMs: INITIAL_MUTAGEN_CREATE_TIMEOUT_MS,
            maxBufferBytes: 256 * 1024,
          });
          await this.waitForSynchronizableSession(mutagenCommand, target);
        }
        await this.flushSyncWithRecovery({
          mutagenCommand,
          target,
          timeoutMs: hasExistingSession
            ? REUSED_MUTAGEN_FLUSH_TIMEOUT_MS
            : INITIAL_MUTAGEN_FLUSH_TIMEOUT_MS,
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
              mutagenBin: mutagenCommand,
            }),
          },
          providerOptions:
            input.provider !== undefined
              ? buildRemoteProviderOptions({
                  stateDir: this.stateDir,
                  provider: input.provider,
                  target,
                  mutagenBin: mutagenCommand,
                  ...(input.baseProviderOptions
                    ? { baseProviderOptions: input.baseProviderOptions }
                    : {}),
                })
              : undefined,
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
          message: `Remote execution sync failed for ${key.replace(/^t3-session=/, "")}: ${detail}`,
          cause,
        });
      },
    });
}

const makeRemoteExecutionManager: Effect.Effect<
  RemoteExecutionManagerRuntime,
  never,
  ServerConfig
> = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  return new RemoteExecutionManagerRuntime(stateDir);
});

export const RemoteExecutionManagerLive = Layer.effect(
  RemoteExecutionManager,
  makeRemoteExecutionManager,
);
