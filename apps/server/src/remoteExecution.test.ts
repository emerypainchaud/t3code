import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildRemoteCodexProviderOptions, ensureRemoteShellScript } from "./remoteExecution.ts";

describe("remoteExecution", () => {
  const createdDirs: string[] = [];

  afterEach(() => {
    for (const dir of createdDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the remote shell script under the server state directory", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-remote-execution-"));
    createdDirs.push(stateDir);

    const scriptPath = ensureRemoteShellScript(stateDir);

    expect(path.basename(scriptPath)).toBe("t3-remote-shell.sh");
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.readFileSync(scriptPath, "utf8")).toContain("MUTAGEN_LABEL_SELECTOR");
  });

  it("builds codex provider options for ssh execution targets", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-remote-execution-"));
    createdDirs.push(stateDir);

    const providerOptions = buildRemoteCodexProviderOptions({
      stateDir,
      target: {
        kind: "ssh",
        label: "GPU box",
        host: "gpu-1.internal",
        username: "ubuntu",
        port: 2222,
        remotePath: "/srv/projects/provider-project",
        sync: {
          mode: "mutagen",
          localPath: "/var/t3/mirrors/provider-project",
          ignores: ["node_modules", ".next"],
        },
      },
    });

    expect(providerOptions).toMatchObject({
      codex: {
        shellEnvironment: {
          T3_REMOTE_HOST: "gpu-1.internal",
          T3_REMOTE_PORT: "2222",
          T3_REMOTE_USER: "ubuntu",
          T3_REMOTE_PATH: "/srv/projects/provider-project",
          T3_LOCAL_PATH: "/var/t3/mirrors/provider-project",
          T3_MUTAGEN_LABEL_SELECTOR: expect.stringContaining("t3-session="),
        },
      },
    });
    expect(providerOptions?.codex?.shellPath).toBeDefined();
    expect(fs.existsSync(providerOptions?.codex?.shellPath ?? "")).toBe(true);
  });
});
