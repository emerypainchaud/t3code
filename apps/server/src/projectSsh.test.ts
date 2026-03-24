import path from "node:path";

import { describe, expect, it } from "vitest";

import { suggestProjectMirrorPath } from "./projectSsh.ts";

describe("suggestProjectMirrorPath", () => {
  it("derives a deterministic mirror path from the SSH target identity", () => {
    const stateDir = "/var/lib/t3";
    const mirrorPath = suggestProjectMirrorPath(stateDir, {
      host: "gpu-1.internal",
      username: "ubuntu",
      port: 2222,
      remotePath: "/srv/projects/model-trainer",
    });

    expect(mirrorPath).toMatch(
      new RegExp(
        `^${stateDir.replace(/\//g, "\\/")}\\/project-mirrors\\/ubuntu-gpu-1.internal-2222-[a-f0-9]{8}\\/model-trainer$`,
      ),
    );
  });

  it("uses the remote basename as the mirror leaf", () => {
    const mirrorPath = suggestProjectMirrorPath("/tmp/t3", {
      host: "buildbox",
      remotePath: "/srv/repos/example-app/",
    });

    expect(path.basename(mirrorPath)).toBe("example-app");
  });
});
