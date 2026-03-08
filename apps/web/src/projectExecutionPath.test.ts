import { describe, expect, it } from "vitest";

import {
  resolveDraftExecutionTarget,
  resolveExecutionCwd,
  resolveProjectExecutionRoot,
} from "./projectExecutionPath";

describe("projectExecutionPath", () => {
  it("uses the workspace root for local projects", () => {
    expect(
      resolveProjectExecutionRoot({
        cwd: "/workspace/project",
        executionTarget: { kind: "workspace-local" },
      }),
    ).toBe("/workspace/project");
  });

  it("uses the mirror path for ssh projects", () => {
    expect(
      resolveProjectExecutionRoot({
        cwd: "/workspace/project",
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
      }),
    ).toBe("/mirror/project");
  });

  it("prefers the worktree path when present", () => {
    expect(
      resolveExecutionCwd({
        project: {
          cwd: "/workspace/project",
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
        worktreePath: "/mirror/project-worktrees/feature-a",
      }),
    ).toBe("/mirror/project-worktrees/feature-a");
  });

  it("inherits the draft execution target from the project", () => {
    expect(
      resolveDraftExecutionTarget({
        project: {
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
      }),
    ).toEqual({
      kind: "ssh",
      host: "remote.example.com",
      remotePath: "/srv/project",
      sync: {
        mode: "mutagen",
        localPath: "/mirror/project",
        ignores: [],
      },
    });
  });
});
