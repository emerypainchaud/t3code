import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import type { ProjectExecutionTarget, ProjectId, ThreadId } from "@t3tools/contracts";

import { RemoteExecutionError, type RemoteExecutionManagerShape } from "./remoteExecutionManager.ts";
import { resolveTerminalLaunchInput, TerminalLaunchResolutionError } from "./terminalLaunch.ts";

const asThreadId = (value: string): ThreadId => value as ThreadId;
const asProjectId = (value: string): ProjectId => value as ProjectId;

function makeRemoteExecutionMock() {
  const prepareLaunch = vi.fn<RemoteExecutionManagerShape["prepareLaunch"]>((launch) =>
    Effect.succeed({
      cwd: launch.cwd,
      terminalEnv: launch.target.kind === "ssh" ? { SHELL: "/tmp/t3-remote-shell.sh" } : undefined,
      providerOptions: undefined,
      syncState: {
        key: launch.target.kind === "ssh" ? "ssh" : "workspace-local",
        status: launch.target.kind === "ssh" ? "ready" : "local",
        updatedAt: "2026-03-07T00:00:00.000Z",
        detail: null,
      },
    }),
  );

  const remoteExecution: RemoteExecutionManagerShape = {
    prepareLaunch,
    getSyncState: () =>
      Effect.succeed({
        key: "workspace-local",
        status: "local",
        updatedAt: "2026-03-07T00:00:00.000Z",
        detail: null,
      }),
  };

  return { prepareLaunch, remoteExecution };
}

describe("resolveTerminalLaunchInput", () => {
  it("resolves persisted threads through the pinned execution target", async () => {
    const { prepareLaunch, remoteExecution } = makeRemoteExecutionMock();
    const sshTarget: ProjectExecutionTarget = {
      kind: "ssh",
      host: "build.example.com",
      remotePath: "/srv/project",
      sync: {
        mode: "mutagen",
        localPath: "/mirror/project",
        ignores: ["node_modules"],
      },
    };

    const result = await Effect.runPromise(
      resolveTerminalLaunchInput({
        request: {
          threadId: asThreadId("thread-1"),
          cwd: "/tmp/fallback",
          env: { BASE: "1" },
        },
        snapshot: {
          threads: [
            {
              id: asThreadId("thread-1"),
              projectId: asProjectId("project-1"),
              worktreePath: null,
              executionTarget: sshTarget,
            },
          ],
          projects: [
            {
              id: asProjectId("project-1"),
              workspaceRoot: "/workspace/project",
              executionTarget: { kind: "workspace-local" },
            },
          ],
        },
        remoteExecution,
      }),
    );

    expect(prepareLaunch).toHaveBeenCalledWith({
      cwd: "/mirror/project",
      target: sshTarget,
    });
    expect(result).toEqual({
      cwd: "/mirror/project",
      env: {
        BASE: "1",
        SHELL: "/tmp/t3-remote-shell.sh",
      },
    });
  });

  it("resolves draft threads through the project execution target", async () => {
    const { prepareLaunch, remoteExecution } = makeRemoteExecutionMock();
    const sshTarget: ProjectExecutionTarget = {
      kind: "ssh",
      host: "gpu.example.com",
      remotePath: "/srv/ml",
      sync: {
        mode: "mutagen",
        localPath: "/mirror/ml",
        ignores: [],
      },
    };

    const result = await Effect.runPromise(
      resolveTerminalLaunchInput({
        request: {
          threadId: asThreadId("draft-thread"),
          projectId: asProjectId("project-2"),
          cwd: "/mirror/ml/worktrees/feature-a",
        },
        snapshot: {
          threads: [],
          projects: [
            {
              id: asProjectId("project-2"),
              workspaceRoot: "/workspace/ml",
              executionTarget: sshTarget,
            },
          ],
        },
        remoteExecution,
      }),
    );

    expect(prepareLaunch).toHaveBeenCalledWith({
      cwd: "/mirror/ml/worktrees/feature-a",
      target: sshTarget,
    });
    expect(result).toEqual({
      cwd: "/mirror/ml/worktrees/feature-a",
      env: {
        SHELL: "/tmp/t3-remote-shell.sh",
      },
    });
  });

  it("falls back to the caller launch input when no thread or project exists", async () => {
    const { prepareLaunch, remoteExecution } = makeRemoteExecutionMock();

    const result = await Effect.runPromise(
      resolveTerminalLaunchInput({
        request: {
          threadId: asThreadId("draft-thread"),
          cwd: "/tmp/fallback",
          env: { HELLO: "world" },
        },
        snapshot: {
          threads: [],
          projects: [],
        },
        remoteExecution,
      }),
    );

    expect(prepareLaunch).not.toHaveBeenCalled();
    expect(result).toEqual({
      cwd: "/tmp/fallback",
      env: { HELLO: "world" },
    });
  });

  it("fails for unknown project ids", async () => {
    const { remoteExecution } = makeRemoteExecutionMock();

    await expect(
      Effect.runPromise(
        resolveTerminalLaunchInput({
          request: {
            threadId: asThreadId("draft-thread"),
            projectId: asProjectId("missing-project"),
            cwd: "/tmp/fallback",
          },
          snapshot: {
            threads: [],
            projects: [],
          },
          remoteExecution,
        }),
      ),
    ).rejects.toBeInstanceOf(TerminalLaunchResolutionError);
  });

  it("surfaces remote execution failures", async () => {
    const failure = new RemoteExecutionError({
      message: "mutagen failed",
      cause: new Error("mutagen failed"),
    });
    const remoteExecution: RemoteExecutionManagerShape = {
      prepareLaunch: () => Effect.fail(failure),
      getSyncState: () =>
        Effect.succeed({
          key: "ssh",
          status: "error",
          updatedAt: "2026-03-07T00:00:00.000Z",
          detail: "mutagen failed",
        }),
    };

    await expect(
      Effect.runPromise(
        resolveTerminalLaunchInput({
          request: {
            threadId: asThreadId("draft-thread"),
            projectId: asProjectId("project-1"),
            cwd: "/tmp/fallback",
          },
          snapshot: {
            threads: [],
            projects: [
              {
                id: asProjectId("project-1"),
                workspaceRoot: "/workspace",
                executionTarget: {
                  kind: "ssh",
                  host: "remote.example.com",
                  remotePath: "/srv/project",
                  sync: {
                    mode: "mutagen",
                    localPath: "/mirror/project",
                    ignores: [],
                  },
                },
              },
            ],
          },
          remoteExecution,
        }),
      ),
    ).rejects.toBe(failure);
  });
});
