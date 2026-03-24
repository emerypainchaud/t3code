import { describe, expect, it } from "vitest";

import type { AppWorkspace } from "./appSettings";
import { resolveExternalUrlWithContext } from "./externalUrl";

const localWorkspace: AppWorkspace = {
  id: "local",
  name: "This server",
  wsUrl: "",
  authToken: "",
  isLocal: true,
  deployment: null,
  ssh: null,
};

const remoteWorkspace: AppWorkspace = {
  id: "remote-1",
  name: "Remote",
  wsUrl: "ws://bamboozler:3773",
  authToken: "secret",
  isLocal: false,
  deployment: {
    host: "bamboozler",
    connectHost: "bamboozler",
  },
  ssh: null,
};

describe("resolveExternalUrlWithContext", () => {
  it("rewrites remote workspace loopback urls to the workspace host", () => {
    expect(
      resolveExternalUrlWithContext("http://localhost:3000/app", {
        workspace: remoteWorkspace,
      }),
    ).toBe("http://bamboozler:3000/app");
  });

  it("rewrites ssh project loopback urls to the ssh target host", () => {
    expect(
      resolveExternalUrlWithContext("http://127.0.0.1:8080", {
        workspace: localWorkspace,
        executionTarget: {
          kind: "ssh",
          host: "gpu-box.internal",
          remotePath: "/srv/project",
          sync: {
            mode: "mutagen",
            localPath: "/tmp/project",
            ignores: [],
          },
        },
      }),
    ).toBe("http://gpu-box.internal:8080/");
  });

  it("leaves non-loopback urls unchanged", () => {
    expect(
      resolveExternalUrlWithContext("https://github.com/emerypainchaud/t3code", {
        workspace: remoteWorkspace,
      }),
    ).toBe("https://github.com/emerypainchaud/t3code");
  });
});
