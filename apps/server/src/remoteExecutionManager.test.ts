import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";

import { RemoteExecutionManagerRuntime } from "./remoteExecutionManager.ts";

describe("RemoteExecutionManagerRuntime", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ensures and flushes mutagen syncs for ssh targets", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-remote-manager-"));
    createdDirs.push(stateDir);
    const processRunner = vi
      .fn()
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false })
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false })
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, signal: null, timedOut: false });
    const manager = new RemoteExecutionManagerRuntime(stateDir, processRunner);

    const launch = await Effect.runPromise(
      manager.prepareLaunch({
        cwd: undefined,
        target: {
          kind: "ssh",
          label: "GPU box",
          host: "gpu-1.internal",
          username: "ubuntu",
          port: 2222,
          remotePath: "/srv/projects/provider-project",
          sync: {
            mode: "mutagen",
            localPath: path.join(stateDir, "mirror"),
            ignores: ["node_modules", ".next"],
          },
        },
      }),
    );

    expect(processRunner).toHaveBeenNthCalledWith(
      1,
      "mutagen",
      ["sync", "list", "--label-selector", expect.stringContaining("t3-session=")],
      expect.objectContaining({ allowNonZeroExit: true }),
    );
    expect(processRunner).toHaveBeenNthCalledWith(
      2,
      "mutagen",
      expect.arrayContaining(["sync", "create"]),
      expect.any(Object),
    );
    expect(processRunner).toHaveBeenNthCalledWith(
      3,
      "mutagen",
      ["sync", "flush", "--label-selector", expect.stringContaining("t3-session=")],
      expect.any(Object),
    );
    expect(launch.cwd).toBe(path.join(stateDir, "mirror"));
    expect(launch.syncState.status).toBe("ready");
    expect(launch.terminalEnv?.SHELL).toBeDefined();
  });

  it("reports sync errors when mutagen setup fails", async () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-remote-manager-"));
    createdDirs.push(stateDir);
    const processRunner = vi.fn().mockRejectedValue(new Error("Command not found: mutagen"));
    const manager = new RemoteExecutionManagerRuntime(stateDir, processRunner);
    const target = {
      kind: "ssh" as const,
      host: "gpu-1.internal",
      remotePath: "/srv/projects/provider-project",
      sync: {
        mode: "mutagen" as const,
        localPath: path.join(stateDir, "mirror"),
        ignores: [],
      },
    };

    await expect(
      Effect.runPromise(
        manager.prepareLaunch({
          cwd: target.sync.localPath,
          target,
        }),
      ),
    ).rejects.toThrow("Remote execution sync failed");

    const syncState = await Effect.runPromise(manager.getSyncState(target));
    expect(syncState.status).toBe("error");
    expect(syncState.detail).toContain("Command not found: mutagen");
  });
});
