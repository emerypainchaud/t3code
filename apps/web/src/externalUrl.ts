import type { ProjectExecutionTarget } from "@t3tools/contracts";

import type { AppWorkspace } from "./appSettings";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname.trim().toLowerCase());
}

function resolveExternalTargetHostname(input: {
  readonly workspace: AppWorkspace;
  readonly executionTarget?: ProjectExecutionTarget | null | undefined;
}): string | null {
  if (input.executionTarget?.kind === "ssh") {
    const sshHost = input.executionTarget.host.trim();
    return sshHost.length > 0 ? sshHost : null;
  }

  if (input.workspace.isLocal) {
    return null;
  }

  const deploymentConnectHost = input.workspace.deployment?.connectHost?.trim();
  if (deploymentConnectHost) {
    return deploymentConnectHost;
  }

  try {
    const workspaceUrl = new URL(input.workspace.wsUrl);
    return workspaceUrl.hostname.trim() || null;
  } catch {
    return null;
  }
}

export function resolveExternalUrlWithContext(
  rawUrl: string,
  input: {
    readonly workspace: AppWorkspace;
    readonly executionTarget?: ProjectExecutionTarget | null | undefined;
  },
): string {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
    return rawUrl;
  }

  if (!isLoopbackHostname(parsedUrl.hostname)) {
    return rawUrl;
  }

  const targetHostname = resolveExternalTargetHostname(input);
  if (!targetHostname || isLoopbackHostname(targetHostname)) {
    return rawUrl;
  }

  parsedUrl.hostname = targetHostname;
  return parsedUrl.toString();
}
