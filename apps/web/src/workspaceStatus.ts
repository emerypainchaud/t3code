import type { WorkspaceConnectionState } from "./workspaceConnectionState";

export function workspaceStatusLabel(state: WorkspaceConnectionState): string {
  switch (state) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "reconnecting":
      return "Reconnecting";
    case "disconnected":
      return "Disconnected";
  }
}

export function workspaceStatusDotClassName(state: WorkspaceConnectionState): string {
  switch (state) {
    case "connected":
      return "bg-emerald-500";
    case "connecting":
      return "bg-amber-500 animate-pulse";
    case "reconnecting":
      return "bg-amber-500 animate-pulse";
    case "disconnected":
      return "bg-zinc-400";
  }
}

export function workspaceStatusTextClassName(state: WorkspaceConnectionState): string {
  switch (state) {
    case "connected":
      return "text-emerald-600 dark:text-emerald-300/90";
    case "connecting":
      return "text-amber-600 dark:text-amber-300/90";
    case "reconnecting":
      return "text-amber-600 dark:text-amber-300/90";
    case "disconnected":
      return "text-muted-foreground";
  }
}
