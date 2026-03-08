import type { ProjectExecutionTarget, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Schema } from "effect";

import { resolveThreadWorkspaceCwd } from "./checkpointing/Utils.ts";
import type { RemoteExecutionManagerShape } from "./remoteExecutionManager.ts";
import { RemoteExecutionError } from "./remoteExecutionManager.ts";

export class TerminalLaunchResolutionError extends Schema.TaggedErrorClass<TerminalLaunchResolutionError>()(
  "TerminalLaunchResolutionError",
  {
    message: Schema.String,
  },
) {}

export interface TerminalLaunchResolverSnapshot {
  readonly threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    readonly executionTarget: ProjectExecutionTarget;
  }>;
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly executionTarget: ProjectExecutionTarget;
  }>;
}

export interface TerminalLaunchResolverInput {
  readonly threadId: string;
  readonly projectId?: string | undefined;
  readonly cwd: string;
  readonly env?: Record<string, string> | undefined;
}

export function resolveTerminalLaunchInput(input: {
  readonly request: TerminalLaunchResolverInput;
  readonly snapshot: TerminalLaunchResolverSnapshot;
  readonly remoteExecution: RemoteExecutionManagerShape;
}): Effect.Effect<
  { readonly cwd: string; readonly env?: Record<string, string> },
  TerminalLaunchResolutionError | RemoteExecutionError
> {
  const thread = input.snapshot.threads.find((entry) => entry.id === input.request.threadId);
  if (thread) {
    const resolvedCwd = resolveThreadWorkspaceCwd({
      thread,
      projects: input.snapshot.projects,
    });
    if (!resolvedCwd) {
      return Effect.fail(
        new TerminalLaunchResolutionError({
          message: `Missing project for thread: ${input.request.threadId}`,
        }),
      );
    }

    return Effect.map(
      input.remoteExecution.prepareLaunch({
        cwd: resolvedCwd,
        target: thread.executionTarget,
      }),
      (launch) => ({
        cwd: launch.cwd ?? input.request.cwd,
        ...(launch.terminalEnv || input.request.env
          ? {
              env: {
                ...input.request.env,
                ...launch.terminalEnv,
              },
            }
          : {}),
      }),
    );
  }

  const projectId = input.request.projectId;
  if (!projectId) {
    return Effect.succeed({
      cwd: input.request.cwd,
      ...(input.request.env ? { env: input.request.env } : {}),
    });
  }

  const project = input.snapshot.projects.find((entry) => entry.id === projectId);
  if (!project) {
    return Effect.fail(
      new TerminalLaunchResolutionError({
        message: `Unknown project: ${projectId}`,
      }),
    );
  }

  return Effect.map(
    input.remoteExecution.prepareLaunch({
      cwd: input.request.cwd,
      target: project.executionTarget,
    }),
    (launch) => ({
      cwd: launch.cwd ?? input.request.cwd,
      ...(launch.terminalEnv || input.request.env
        ? {
            env: {
              ...input.request.env,
              ...launch.terminalEnv,
            },
          }
        : {}),
    }),
  );
}
