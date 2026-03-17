import type { NativeApi } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vitest";

import { openInEditorWithContext, resolveOpenInEditorOptions } from "./remoteEditorOpen";

describe("resolveOpenInEditorOptions", () => {
  it("adds local SSH-capable editors when a desktop SSH target can be opened locally", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {},
      },
    });

    expect(
      resolveOpenInEditorOptions({
        workspace: {
          id: "remote-1",
          name: "Remote",
          wsUrl: "wss://remote.example.com",
          authToken: "secret",
          isLocal: false,
          deployment: null,
          ssh: {
            host: "remote.example.com",
          },
        },
        executionTarget: null,
        serverPath: "/srv/project",
        availableEditors: ["cursor"],
      }),
    ).toEqual(["cursor", "vscode", "zed"]);
  });
});

describe("openInEditorWithContext", () => {
  it("opens VS Code locally over SSH for remote workspaces in the desktop app", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        desktopBridge: {},
      },
    });

    const api = {
      shell: {
        openInEditor: vi.fn(),
        openInLocalEditorViaSsh: vi.fn().mockResolvedValue({
          opened: true,
          message: "Opened in local editor.",
        }),
      },
    } as unknown as NativeApi;

    await openInEditorWithContext(api, "vscode", {
      workspace: {
        id: "remote-1",
        name: "Remote",
        wsUrl: "wss://remote.example.com",
        authToken: "secret",
        isLocal: false,
        deployment: null,
        ssh: {
          host: "remote.example.com",
          username: "deploy",
          port: 2222,
        },
      },
      executionTarget: null,
      serverPath: "/srv/project",
      targetKind: "directory",
      availableEditors: ["cursor"],
    });

    expect(api.shell.openInLocalEditorViaSsh).toHaveBeenCalledWith({
      editor: "vscode",
      host: "remote.example.com",
      username: "deploy",
      port: 2222,
      remotePath: "/srv/project",
      targetKind: "directory",
    });
    expect(api.shell.openInEditor).not.toHaveBeenCalled();
  });

  it("falls back to server-host editor launch when local SSH open is unavailable", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });

    const api = {
      shell: {
        openInEditor: vi.fn().mockResolvedValue(undefined),
        openInLocalEditorViaSsh: vi.fn(),
      },
    } as unknown as NativeApi;

    await openInEditorWithContext(api, "cursor", {
      workspace: {
        id: "remote-1",
        name: "Remote",
        wsUrl: "wss://remote.example.com",
        authToken: "secret",
        isLocal: false,
        deployment: null,
        ssh: {
          host: "remote.example.com",
        },
      },
      executionTarget: null,
      serverPath: "/srv/project",
      targetKind: "directory",
      availableEditors: ["cursor"],
    });

    expect(api.shell.openInEditor).toHaveBeenCalledWith("/srv/project", "cursor");
    expect(api.shell.openInLocalEditorViaSsh).not.toHaveBeenCalled();
  });
});
