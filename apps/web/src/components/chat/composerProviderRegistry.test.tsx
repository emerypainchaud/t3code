import { describe, expect, it } from "vitest";
import { getComposerProviderState } from "./composerProviderRegistry";

describe("getComposerProviderState", () => {
  it("returns codex defaults when no codex draft options exist", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("normalizes codex dispatch options while preserving the selected effort", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "low",
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "low",
      modelOptionsForDispatch: {
        codex: {
          reasoningEffort: "low",
          fastMode: true,
        },
      },
    });
  });

  it("returns Claude defaults for effort-capable models", () => {
    const state = getComposerProviderState({
      provider: "claudeCode",
      model: "claude-sonnet-4-6",
      prompt: "",
      modelOptions: undefined,
    });

    expect(state).toEqual({
      provider: "claudeCode",
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("tracks Claude ultrathink from the prompt without changing dispatch effort", () => {
    const state = getComposerProviderState({
      provider: "claudeCode",
      model: "claude-sonnet-4-6",
      prompt: "Ultrathink:\nInvestigate this failure",
      modelOptions: {
        claudeCode: {
          effort: "medium",
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeCode",
      promptEffort: "medium",
      modelOptionsForDispatch: {
        claudeCode: {
          effort: "medium",
        },
      },
      composerFrameClassName: "ultrathink-frame",
      composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.04)_inset]",
      modelPickerIconClassName: "ultrathink-chroma",
    });
  });

  it("drops unsupported Claude effort options for models without effort controls", () => {
    const state = getComposerProviderState({
      provider: "claudeCode",
      model: "claude-haiku-4-5",
      prompt: "",
      modelOptions: {
        claudeCode: {
          effort: "max",
          thinking: false,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeCode",
      promptEffort: null,
      modelOptionsForDispatch: {
        claudeCode: {
          thinking: false,
        },
      },
    });
  });

  it("ignores codex options while resolving Claude state", () => {
    const state = getComposerProviderState({
      provider: "claudeCode",
      model: "claude-opus-4-6",
      prompt: "",
      modelOptions: {
        codex: {
          reasoningEffort: "low",
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "claudeCode",
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });

  it("ignores Claude options while resolving codex state", () => {
    const state = getComposerProviderState({
      provider: "codex",
      model: "gpt-5.4",
      prompt: "Ultrathink:\nThis should not matter",
      modelOptions: {
        claudeCode: {
          effort: "max",
          fastMode: true,
        },
      },
    });

    expect(state).toEqual({
      provider: "codex",
      promptEffort: "high",
      modelOptionsForDispatch: undefined,
    });
  });
});
