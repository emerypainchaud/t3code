import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { markThreadUnread, syncServerReadModel, type AppState } from "./store";
import { DEFAULT_INTERACTION_MODE, DEFAULT_RUNTIME_MODE, type Thread } from "./types";

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    codexThreadId: null,
    projectId: ProjectId.makeUnsafe("project-1"),
    executionTarget: {
      kind: "workspace-local",
    },
    title: "Thread",
    model: "gpt-5-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    session: null,
    messages: [],
    turnDiffSummaries: [],
    activities: [],
    proposedPlans: [],
    error: null,
    createdAt: "2026-02-13T00:00:00.000Z",
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

function makeState(thread: Thread): AppState {
  return {
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        name: "Project",
        cwd: "/tmp/project",
        model: "gpt-5-codex",
        expanded: true,
        executionTarget: {
          kind: "workspace-local",
        },
        scripts: [],
      },
    ],
    threads: [thread],
    threadsHydrated: true,
  };
}

function makeReadModelThread(overrides: Partial<OrchestrationReadModel["threads"][number]>) {
  return {
    id: ThreadId.makeUnsafe("thread-1"),
    projectId: ProjectId.makeUnsafe("project-1"),
    executionTarget: {
      kind: "workspace-local",
    },
    title: "Thread",
    model: "gpt-5.3-codex",
    runtimeMode: DEFAULT_RUNTIME_MODE,
    interactionMode: DEFAULT_INTERACTION_MODE,
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-02-27T00:00:00.000Z",
    updatedAt: "2026-02-27T00:00:00.000Z",
    deletedAt: null,
    messages: [],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: null,
    ...overrides,
  } satisfies OrchestrationReadModel["threads"][number];
}

function makeReadModel(thread: OrchestrationReadModel["threads"][number]): OrchestrationReadModel {
  return {
    snapshotSequence: 1,
    updatedAt: "2026-02-27T00:00:00.000Z",
    projects: [
      {
        id: ProjectId.makeUnsafe("project-1"),
        title: "Project",
        workspaceRoot: "/tmp/project",
        defaultModel: "gpt-5.3-codex",
        executionTarget: {
          kind: "workspace-local",
        },
        createdAt: "2026-02-27T00:00:00.000Z",
        updatedAt: "2026-02-27T00:00:00.000Z",
        deletedAt: null,
        scripts: [],
      },
    ],
    threads: [thread],
  };
}

const originalWindow = globalThis.window;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: { origin: "http://localhost:3000" },
      desktopBridge: undefined,
      localStorage: {
        getItem: vi.fn((key: string) => {
          if (key !== "t3code:app-settings:v1") {
            return null;
          }
          return JSON.stringify({
            codexBinaryPath: "",
            claudeBinaryPath: "",
            codexHomePath: "",
            confirmThreadDelete: true,
            enableAssistantStreaming: false,
            codexServiceTier: "auto",
            customCodexModels: [],
            customClaudeCodeModels: [],
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
        }),
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

describe("store pure functions", () => {
  it("markThreadUnread moves lastVisitedAt before completion for a completed thread", () => {
    const latestTurnCompletedAt = "2026-02-25T12:30:00.000Z";
    const initialState = makeState(
      makeThread({
        latestTurn: {
          turnId: TurnId.makeUnsafe("turn-1"),
          state: "completed",
          requestedAt: "2026-02-25T12:28:00.000Z",
          startedAt: "2026-02-25T12:28:30.000Z",
          completedAt: latestTurnCompletedAt,
          assistantMessageId: null,
        },
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    const updatedThread = next.threads[0];
    expect(updatedThread).toBeDefined();
    expect(updatedThread?.lastVisitedAt).toBe("2026-02-25T12:29:59.999Z");
    expect(Date.parse(updatedThread?.lastVisitedAt ?? "")).toBeLessThan(
      Date.parse(latestTurnCompletedAt),
    );
  });

  it("markThreadUnread does not change a thread without a completed turn", () => {
    const initialState = makeState(
      makeThread({
        latestTurn: null,
        lastVisitedAt: "2026-02-25T12:35:00.000Z",
      }),
    );

    const next = markThreadUnread(initialState, ThreadId.makeUnsafe("thread-1"));

    expect(next).toEqual(initialState);
  });
});

describe("store read model sync", () => {
  it("preserves recognized Claude models even without an active session", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        model: "claude-opus-4-6",
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.model).toBe("claude-opus-4-6");
  });

  it("resolves attachment preview urls against the active remote workspace origin", () => {
    const initialState = makeState(makeThread());
    const readModel = makeReadModel(
      makeReadModelThread({
        messages: [
          {
            id: MessageId.makeUnsafe("message-1"),
            role: "user",
            text: "hello",
            turnId: null,
            createdAt: "2026-02-27T00:00:00.000Z",
            updatedAt: "2026-02-27T00:00:00.000Z",
            streaming: false,
            attachments: [
              {
                type: "image",
                id: "attachment-1",
                name: "image.png",
                mimeType: "image/png",
                sizeBytes: 128,
              },
            ],
          },
        ],
      }),
    );

    const next = syncServerReadModel(initialState, readModel);

    expect(next.threads[0]?.messages[0]?.attachments?.[0]?.previewUrl).toBe(
      "https://remote.example.com/attachments/attachment-1",
    );
  });
});
