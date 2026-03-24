import { getAppSettingsSnapshot, resolveActiveWorkspace, type AppWorkspace } from "./appSettings";

function resolveBootWebSocketUrl(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const bridgeWsUrl = window.desktopBridge?.getWsUrl?.();
  if (typeof bridgeWsUrl === "string" && bridgeWsUrl.length > 0) {
    return bridgeWsUrl;
  }
  const envWsUrl = import.meta.env.VITE_WS_URL as string | undefined;
  if (typeof envWsUrl === "string" && envWsUrl.length > 0) {
    return envWsUrl;
  }
  return null;
}

export function resolveHttpOriginFromWebSocketUrl(
  webSocketUrl: string | null | undefined,
): string | null {
  const trimmed = webSocketUrl?.trim() ?? "";
  if (trimmed.length === 0) {
    return null;
  }
  try {
    const wsUrl = new URL(trimmed);
    const protocol =
      wsUrl.protocol === "wss:" ? "https:" : wsUrl.protocol === "ws:" ? "http:" : null;
    if (!protocol) {
      return null;
    }
    return `${protocol}//${wsUrl.host}`;
  } catch {
    return null;
  }
}

export function resolveBootHttpOrigin(): string {
  const configuredOrigin = resolveHttpOriginFromWebSocketUrl(resolveBootWebSocketUrl());
  if (configuredOrigin) {
    return configuredOrigin;
  }
  if (typeof window === "undefined") {
    return "";
  }
  return window.location.origin;
}

export function resolveWorkspaceHttpOrigin(
  workspace: Pick<AppWorkspace, "isLocal" | "wsUrl"> | null | undefined,
): string {
  if (workspace && !workspace.isLocal) {
    const remoteOrigin = resolveHttpOriginFromWebSocketUrl(workspace.wsUrl);
    if (remoteOrigin) {
      return remoteOrigin;
    }
  }
  return resolveBootHttpOrigin();
}

export function resolveActiveWorkspaceHttpOrigin(): string {
  return resolveWorkspaceHttpOrigin(resolveActiveWorkspace(getAppSettingsSnapshot()));
}

export function resolveWorkspaceHttpUrl(
  pathOrUrl: string,
  workspace: Pick<AppWorkspace, "isLocal" | "wsUrl"> | null | undefined,
): string {
  if (!pathOrUrl.startsWith("/")) {
    return pathOrUrl;
  }
  return `${resolveWorkspaceHttpOrigin(workspace)}${pathOrUrl}`;
}

export function resolveActiveWorkspaceHttpUrl(pathOrUrl: string): string {
  if (!pathOrUrl.startsWith("/")) {
    return pathOrUrl;
  }
  return `${resolveActiveWorkspaceHttpOrigin()}${pathOrUrl}`;
}
