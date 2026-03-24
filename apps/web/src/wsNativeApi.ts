import {
  OrchestrationEvent,
  ORCHESTRATION_WS_CHANNELS,
  ORCHESTRATION_WS_METHODS,
  type ContextMenuItem,
  type NativeApi,
  ServerConfigUpdatedPayload,
  TerminalEvent,
  WS_CHANNELS,
  WS_METHODS,
  WsWelcomePayload,
} from "@t3tools/contracts";
import { Cause, Schema } from "effect";

import {
  getAppSettingsSnapshot,
  resolveActiveWorkspace,
  subscribeAppSettings,
} from "./appSettings";
import { showContextMenuFallback } from "./contextMenuFallback";
import { setWorkspaceConnectionState } from "./workspaceConnectionState";
import { WsTransport } from "./wsTransport";

let instance: NativeApi | null = null;
let transport: WsTransport | null = null;
let transportSignature: string | null = null;
let transportUnsubscribe: (() => void) | null = null;
let settingsUnsubscribe: (() => void) | null = null;

const welcomeListeners = new Set<(payload: WsWelcomePayload) => void>();
const serverConfigUpdatedListeners = new Set<(payload: ServerConfigUpdatedPayload) => void>();
const terminalEventListeners = new Set<(payload: TerminalEvent) => void>();
const domainEventListeners = new Set<(payload: OrchestrationEvent) => void>();

let lastWelcome: WsWelcomePayload | null = null;
let lastServerConfigUpdated: ServerConfigUpdatedPayload | null = null;

const decodeAndWarnOnFailure = <T>(
  schema: Schema.Schema<T> & { readonly DecodingServices: never },
  raw: unknown,
): T | null => {
  const decoded = Schema.decodeUnknownExit(schema)(raw);
  if (decoded._tag === "Failure") {
    console.warn("Dropped inbound WebSocket push payload", {
      reason: "decode-failed",
      raw,
      issue: Cause.pretty(decoded.cause),
    });
    return null;
  }
  return decoded.value;
};

function activeTransportConfig() {
  const workspace = resolveActiveWorkspace(getAppSettingsSnapshot());
  return {
    workspaceId: workspace.id,
    url: workspace.isLocal ? undefined : workspace.wsUrl,
    authToken: workspace.isLocal ? null : workspace.authToken,
  };
}

function toTransportSignature(): string {
  const config = activeTransportConfig();
  return `${config.workspaceId}\u0000${config.url ?? ""}\u0000${config.authToken ?? ""}`;
}

function disposeTransportSubscription(): void {
  if (transportUnsubscribe) {
    transportUnsubscribe();
    transportUnsubscribe = null;
  }
}

function attachTransportListeners(nextTransport: WsTransport, workspaceId: string): void {
  const unsubscribes = [
    nextTransport.subscribeConnectionState((state) => {
      setWorkspaceConnectionState(workspaceId, state);
    }),
    nextTransport.subscribe(WS_CHANNELS.serverWelcome, (data) => {
      const payload = decodeAndWarnOnFailure(WsWelcomePayload, data);
      if (!payload) {
        return;
      }
      lastWelcome = payload;
      for (const listener of welcomeListeners) {
        try {
          listener(payload);
        } catch {
          // Swallow listener errors.
        }
      }
    }),
    nextTransport.subscribe(WS_CHANNELS.serverConfigUpdated, (data) => {
      const payload = decodeAndWarnOnFailure(ServerConfigUpdatedPayload, data);
      if (!payload) {
        return;
      }
      lastServerConfigUpdated = payload;
      for (const listener of serverConfigUpdatedListeners) {
        try {
          listener(payload);
        } catch {
          // Swallow listener errors.
        }
      }
    }),
    nextTransport.subscribe(WS_CHANNELS.terminalEvent, (data) => {
      const payload = decodeAndWarnOnFailure(TerminalEvent, data);
      if (!payload) {
        return;
      }
      for (const listener of terminalEventListeners) {
        try {
          listener(payload);
        } catch {
          // Swallow listener errors.
        }
      }
    }),
    nextTransport.subscribe(ORCHESTRATION_WS_CHANNELS.domainEvent, (data) => {
      const payload = decodeAndWarnOnFailure(OrchestrationEvent, data);
      if (!payload) {
        return;
      }
      for (const listener of domainEventListeners) {
        try {
          listener(payload);
        } catch {
          // Swallow listener errors.
        }
      }
    }),
  ];

  transportUnsubscribe = () => {
    for (const unsubscribe of unsubscribes) {
      unsubscribe();
    }
  };
}

function ensureTransport(): WsTransport {
  const nextSignature = toTransportSignature();
  if (transport && transportSignature === nextSignature) {
    return transport;
  }

  disposeTransportSubscription();
  transport?.dispose();
  transport = null;
  transportSignature = nextSignature;
  lastWelcome = null;
  lastServerConfigUpdated = null;

  const config = activeTransportConfig();
  transport = new WsTransport({
    ...(config.url ? { url: config.url } : {}),
    ...(config.authToken ? { authToken: config.authToken } : {}),
  });
  setWorkspaceConnectionState(config.workspaceId, "connecting");
  attachTransportListeners(transport, config.workspaceId);
  return transport;
}

function ensureSettingsSubscription(): void {
  if (settingsUnsubscribe || typeof window === "undefined") {
    return;
  }
  settingsUnsubscribe = subscribeAppSettings(() => {
    if (!instance) {
      return;
    }
    ensureTransport();
  });
}

/**
 * Subscribe to the server welcome message. If a welcome was already received
 * before this call, the listener fires synchronously with the cached payload.
 * This avoids the race between WebSocket connect and React effect registration.
 */
export function onServerWelcome(listener: (payload: WsWelcomePayload) => void): () => void {
  welcomeListeners.add(listener);

  if (lastWelcome) {
    try {
      listener(lastWelcome);
    } catch {
      // Swallow listener errors.
    }
  }

  return () => {
    welcomeListeners.delete(listener);
  };
}

/**
 * Subscribe to server config update events. Replays the latest update for
 * late subscribers to avoid missing config validation feedback.
 */
export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload) => void,
): () => void {
  serverConfigUpdatedListeners.add(listener);

  if (lastServerConfigUpdated) {
    try {
      listener(lastServerConfigUpdated);
    } catch {
      // Swallow listener errors.
    }
  }

  return () => {
    serverConfigUpdatedListeners.delete(listener);
  };
}

export function createWsNativeApi(): NativeApi {
  if (instance) {
    return instance;
  }

  ensureSettingsSubscription();
  ensureTransport();

  instance = {
    dialogs: {
      pickFolder: async () => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder();
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    terminal: {
      open: (input) => ensureTransport().request(WS_METHODS.terminalOpen, input),
      write: (input) => ensureTransport().request(WS_METHODS.terminalWrite, input),
      resize: (input) => ensureTransport().request(WS_METHODS.terminalResize, input),
      clear: (input) => ensureTransport().request(WS_METHODS.terminalClear, input),
      restart: (input) => ensureTransport().request(WS_METHODS.terminalRestart, input),
      close: (input) => ensureTransport().request(WS_METHODS.terminalClose, input),
      onEvent: (callback) => {
        terminalEventListeners.add(callback);
        ensureTransport();
        return () => {
          terminalEventListeners.delete(callback);
        };
      },
    },
    projects: {
      listDirectory: (input) => ensureTransport().request(WS_METHODS.projectsListDirectory, input),
      createDirectory: (input) =>
        ensureTransport().request(WS_METHODS.projectsCreateDirectory, input),
      listSshDirectory: (input) =>
        ensureTransport().request(WS_METHODS.projectsSshListDirectory, input),
      createSshDirectory: (input) =>
        ensureTransport().request(WS_METHODS.projectsSshCreateDirectory, input),
      preflightSshTarget: (input) =>
        ensureTransport().request(WS_METHODS.projectsSshPreflight, input),
      searchEntries: (input) => ensureTransport().request(WS_METHODS.projectsSearchEntries, input),
      writeFile: (input) => ensureTransport().request(WS_METHODS.projectsWriteFile, input),
    },
    shell: {
      openInEditor: (cwd, editor) =>
        ensureTransport().request(WS_METHODS.shellOpenInEditor, { cwd, editor }),
      openInLocalEditorViaSsh: async (input) => {
        if (!window.desktopBridge) {
          throw new Error("Local SSH editor open is only available in the desktop app.");
        }
        return window.desktopBridge.openInLocalEditorViaSsh(input);
      },
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    git: {
      pull: (input) => ensureTransport().request(WS_METHODS.gitPull, input),
      status: (input) => ensureTransport().request(WS_METHODS.gitStatus, input),
      runStackedAction: (input) => ensureTransport().request(WS_METHODS.gitRunStackedAction, input),
      listBranches: (input) => ensureTransport().request(WS_METHODS.gitListBranches, input),
      createWorktree: (input) => ensureTransport().request(WS_METHODS.gitCreateWorktree, input),
      removeWorktree: (input) => ensureTransport().request(WS_METHODS.gitRemoveWorktree, input),
      createBranch: (input) => ensureTransport().request(WS_METHODS.gitCreateBranch, input),
      checkout: (input) => ensureTransport().request(WS_METHODS.gitCheckout, input),
      init: (input) => ensureTransport().request(WS_METHODS.gitInit, input),
      resolvePullRequest: (input) =>
        ensureTransport().request(WS_METHODS.gitResolvePullRequest, input),
      preparePullRequestThread: (input) =>
        ensureTransport().request(WS_METHODS.gitPreparePullRequestThread, input),
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        return showContextMenuFallback(items, position);
      },
    },
    server: {
      getConfig: () => ensureTransport().request(WS_METHODS.serverGetConfig),
      upsertKeybinding: (input) =>
        ensureTransport().request(WS_METHODS.serverUpsertKeybinding, input),
      rotateWorkspaceAccessToken: () =>
        ensureTransport().request(WS_METHODS.serverRotateWorkspaceAccessToken),
      rotateWorkspaceTlsCertificate: () =>
        ensureTransport().request(WS_METHODS.serverRotateWorkspaceTlsCertificate),
      inspectRemoteTlsCertificate: async (url) => {
        if (!window.desktopBridge) {
          throw new Error("Certificate trust is only available in the desktop app.");
        }
        return window.desktopBridge.inspectRemoteTlsCertificate(url);
      },
      trustRemoteTlsCertificate: async (input) => {
        if (!window.desktopBridge) {
          throw new Error("Certificate trust is only available in the desktop app.");
        }
        await window.desktopBridge.trustRemoteTlsCertificate(input);
      },
      deployRemoteWorkspaceServer: async (input) => {
        if (!window.desktopBridge) {
          throw new Error("Remote workspace deployment is only available in the desktop app.");
        }
        return window.desktopBridge.deployRemoteWorkspaceServer(input);
      },
    },
    orchestration: {
      getSnapshot: () => ensureTransport().request(ORCHESTRATION_WS_METHODS.getSnapshot),
      dispatchCommand: (command) =>
        ensureTransport().request(ORCHESTRATION_WS_METHODS.dispatchCommand, { command }),
      getTurnDiff: (input) =>
        ensureTransport().request(ORCHESTRATION_WS_METHODS.getTurnDiff, input),
      getFullThreadDiff: (input) =>
        ensureTransport().request(ORCHESTRATION_WS_METHODS.getFullThreadDiff, input),
      replayEvents: (fromSequenceExclusive) =>
        ensureTransport().request(ORCHESTRATION_WS_METHODS.replayEvents, { fromSequenceExclusive }),
      onDomainEvent: (callback) => {
        domainEventListeners.add(callback);
        ensureTransport();
        return () => {
          domainEventListeners.delete(callback);
        };
      },
    },
  };

  if (!instance) {
    throw new Error("WebSocket native API failed to initialize.");
  }
  return instance;
}
