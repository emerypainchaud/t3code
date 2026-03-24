import { describe, expect, it } from "vitest";

import {
  parseExecutionTargetIgnores,
  projectExecutionTargetDescription,
  projectExecutionTargetLabel,
  serializeExecutionTargetIgnores,
} from "./projectExecutionTarget";

describe("projectExecutionTarget", () => {
  it("formats local execution targets", () => {
    expect(projectExecutionTargetLabel({ kind: "workspace-local" })).toBe("This server");
    expect(projectExecutionTargetDescription({ kind: "workspace-local" })).toBe(
      "Runs directly on the workspace host.",
    );
  });

  it("formats ssh execution targets with label preference", () => {
    expect(
      projectExecutionTargetLabel({
        kind: "ssh",
        label: "GPU box",
        host: "gpu-1.internal",
        username: "ubuntu",
        port: 2222,
        remotePath: "/srv/repo",
        sync: {
          mode: "mutagen",
          localPath: "/mirror/repo",
          ignores: ["node_modules"],
        },
      }),
    ).toBe("GPU box");
    expect(
      projectExecutionTargetDescription({
        kind: "ssh",
        host: "gpu-1.internal",
        username: "ubuntu",
        port: 2222,
        remotePath: "/srv/repo",
        sync: {
          mode: "mutagen",
          localPath: "/mirror/repo",
          ignores: ["node_modules"],
        },
      }),
    ).toBe("ubuntu@gpu-1.internal:2222 via SSH + mutagen");
  });

  it("deduplicates and trims ignore patterns", () => {
    expect(parseExecutionTargetIgnores(" node_modules \n\n.next\nnode_modules\n dist ")).toEqual([
      "node_modules",
      ".next",
      "dist",
    ]);
    expect(serializeExecutionTargetIgnores(["node_modules", ".next"])).toBe("node_modules\n.next");
  });
});
