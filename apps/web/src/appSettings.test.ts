import { describe, expect, it } from "vitest";

import {
  getAppModelOptions,
  getAppWorkspaces,
  getSlashModelOptions,
  normalizeCustomModelSlugs,
  normalizeWorkspaceUrl,
  resolveActiveWorkspace,
  resolveAppServiceTier,
  shouldShowFastTierIcon,
  resolveAppModelSelection,
} from "./appSettings";

describe("normalizeCustomModelSlugs", () => {
  it("normalizes aliases, removes built-ins, and deduplicates values", () => {
    expect(
      normalizeCustomModelSlugs([
        " custom/internal-model ",
        "gpt-5.3-codex",
        "5.3",
        "custom/internal-model",
        "",
        null,
      ]),
    ).toEqual(["custom/internal-model"]);
  });
});

describe("getAppModelOptions", () => {
  it("appends saved custom models after the built-in options", () => {
    const options = getAppModelOptions("codex", ["custom/internal-model"]);

    expect(options.map((option) => option.slug)).toEqual([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
      "gpt-5.2-codex",
      "gpt-5.2",
      "custom/internal-model",
    ]);
  });

  it("keeps the currently selected custom model available even if it is no longer saved", () => {
    const options = getAppModelOptions("codex", [], "custom/selected-model");

    expect(options.at(-1)).toEqual({
      slug: "custom/selected-model",
      name: "custom/selected-model",
      isCustom: true,
    });
  });
});

describe("resolveAppModelSelection", () => {
  it("preserves saved custom model slugs instead of falling back to the default", () => {
    expect(resolveAppModelSelection("codex", ["galapagos-alpha"], "galapagos-alpha")).toBe(
      "galapagos-alpha",
    );
  });

  it("falls back to the provider default when no model is selected", () => {
    expect(resolveAppModelSelection("codex", [], "")).toBe("gpt-5.4");
  });
});

describe("getSlashModelOptions", () => {
  it("includes saved custom model slugs for /model command suggestions", () => {
    const options = getSlashModelOptions(
      "codex",
      ["custom/internal-model"],
      "",
      "gpt-5.3-codex",
    );

    expect(options.some((option) => option.slug === "custom/internal-model")).toBe(true);
  });

  it("filters slash-model suggestions across built-in and custom model names", () => {
    const options = getSlashModelOptions(
      "codex",
      ["openai/gpt-oss-120b"],
      "oss",
      "gpt-5.3-codex",
    );

    expect(options.map((option) => option.slug)).toEqual(["openai/gpt-oss-120b"]);
  });
});

describe("resolveAppServiceTier", () => {
  it("maps automatic to no override", () => {
    expect(resolveAppServiceTier("auto")).toBeNull();
  });

  it("preserves explicit service tier overrides", () => {
    expect(resolveAppServiceTier("fast")).toBe("fast");
    expect(resolveAppServiceTier("flex")).toBe("flex");
  });
});

describe("shouldShowFastTierIcon", () => {
  it("shows the fast-tier icon only for gpt-5.4 on fast tier", () => {
    expect(shouldShowFastTierIcon("gpt-5.4", "fast")).toBe(true);
    expect(shouldShowFastTierIcon("gpt-5.4", "auto")).toBe(false);
    expect(shouldShowFastTierIcon("gpt-5.3-codex", "fast")).toBe(false);
  });
});

describe("workspace settings", () => {
  it("normalizes remote workspace urls to websocket origins", () => {
    expect(normalizeWorkspaceUrl("https://remote.example.com")).toBe("wss://remote.example.com");
    expect(normalizeWorkspaceUrl("http://127.0.0.1:3773")).toBe("ws://127.0.0.1:3773");
  });

  it("exposes the implicit local workspace and resolves the active remote workspace", () => {
    const settings = {
      codexBinaryPath: "",
      codexHomePath: "",
      defaultThreadEnvMode: "local" as const,
      confirmThreadDelete: true,
      enableAssistantStreaming: false,
      timestampFormat: "locale" as const,
      codexServiceTier: "auto" as const,
      customCodexModels: [],
      customClaudeCodeModels: [],
      activeWorkspaceId: "remote-1",
      workspaces: [
        {
          id: "remote-1",
          name: "Remote",
          wsUrl: "https://remote.example.com",
          authToken: "secret",
        },
      ],
    };

    const workspaces = getAppWorkspaces(settings);
    expect(workspaces.map((workspace) => workspace.id)).toEqual(["local", "remote-1"]);
    expect(resolveActiveWorkspace(settings)).toEqual(
      expect.objectContaining({
        id: "remote-1",
        name: "Remote",
        wsUrl: "wss://remote.example.com",
        authToken: "secret",
        isLocal: false,
      }),
    );
  });
});
