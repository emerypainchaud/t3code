import { useSyncExternalStore } from "react";

export type WorkspaceConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected";

const listeners = new Set<() => void>();
const stateByWorkspaceId = new Map<string, WorkspaceConnectionState>();

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function setWorkspaceConnectionState(
  workspaceId: string,
  state: WorkspaceConnectionState,
): void {
  if (workspaceId.length === 0) {
    return;
  }
  if (stateByWorkspaceId.get(workspaceId) === state) {
    return;
  }
  stateByWorkspaceId.set(workspaceId, state);
  emitChange();
}

export function getWorkspaceConnectionStateSnapshot(workspaceId: string): WorkspaceConnectionState {
  return stateByWorkspaceId.get(workspaceId) ?? "disconnected";
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useWorkspaceConnectionState(workspaceId: string): WorkspaceConnectionState {
  return useSyncExternalStore(
    subscribe,
    () => getWorkspaceConnectionStateSnapshot(workspaceId),
    () => "disconnected",
  );
}
