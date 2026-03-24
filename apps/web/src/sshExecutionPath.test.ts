import { describe, expect, it } from "vitest";

import { buildSshWorktreePath, resolveSshRemotePathForLocalPath } from "./sshExecutionPath";

describe("sshExecutionPath", () => {
  it("maps a local mirror worktree path onto the corresponding remote worktree path", () => {
    expect(
      resolveSshRemotePathForLocalPath(
        {
          kind: "ssh",
          host: "bamboozler",
          remotePath: "/srv/repo",
          sync: {
            mode: "mutagen",
            localPath: "/var/t3/mirrors/repo",
            ignores: [],
          },
        },
        "/var/t3/mirrors/repo/.t3code/worktrees/feature-a",
      ),
    ).toBe("/srv/repo/.t3code/worktrees/feature-a");
  });

  it("builds ssh worktrees inside the synced mirror root", () => {
    expect(
      buildSshWorktreePath(
        {
          kind: "ssh",
          host: "bamboozler",
          remotePath: "/srv/repo",
          sync: {
            mode: "mutagen",
            localPath: "/var/t3/mirrors/repo",
            ignores: [],
          },
        },
        "feature/test",
      ),
    ).toBe("/var/t3/mirrors/repo/.t3code/worktrees/feature-test");
  });
});
