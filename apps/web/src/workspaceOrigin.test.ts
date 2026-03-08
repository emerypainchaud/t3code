import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  resolveActiveWorkspaceHttpOrigin,
  resolveBootHttpOrigin,
  resolveHttpOriginFromWebSocketUrl,
  resolveWorkspaceHttpUrl,
} from "./workspaceOrigin";

const originalWindow = globalThis.window;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost:3000" },
      desktopBridge: undefined,
      localStorage: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    },
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

describe("workspaceOrigin", () => {
  it("maps ws and wss websocket urls to http origins", () => {
    expect(resolveHttpOriginFromWebSocketUrl("ws://127.0.0.1:3773")).toBe("http://127.0.0.1:3773");
    expect(resolveHttpOriginFromWebSocketUrl("wss://remote.example.com/socket")).toBe(
      "https://remote.example.com",
    );
  });

  it("falls back to the current app origin for the local workspace", () => {
    expect(resolveBootHttpOrigin()).toBe("http://localhost:3000");
    expect(
      resolveWorkspaceHttpUrl("/attachments/attachment-1", {
        isLocal: true,
        wsUrl: "",
      }),
    ).toBe("http://localhost:3000/attachments/attachment-1");
  });

  it("uses the active remote workspace websocket origin for http asset urls", () => {
    window.localStorage.getItem = vi.fn((key: string) => {
      if (key !== "t3code:app-settings:v1") {
        return null;
      }
      return JSON.stringify({
        codexBinaryPath: "",
        codexHomePath: "",
        confirmThreadDelete: true,
        enableAssistantStreaming: false,
        codexServiceTier: "auto",
        customCodexModels: [],
        activeWorkspaceId: "remote-1",
        workspaces: [
          {
            id: "remote-1",
            name: "Remote",
            wsUrl: "wss://remote.example.com/socket",
            authToken: "secret",
          },
        ],
      });
    });

    expect(resolveActiveWorkspaceHttpOrigin()).toBe("https://remote.example.com");
    expect(
      resolveWorkspaceHttpUrl("/api/project-favicon", {
        isLocal: false,
        wsUrl: "wss://remote.example.com/socket",
      }),
    ).toBe("https://remote.example.com/api/project-favicon");
  });
});
