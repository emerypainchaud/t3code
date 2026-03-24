import type { ProjectExecutionTarget } from "@t3tools/contracts";

export const DEFAULT_PROJECT_EXECUTION_TARGET: ProjectExecutionTarget = {
  kind: "workspace-local",
};

export const DEFAULT_PROJECT_EXECUTION_SYNC_IGNORES = [
  "node_modules",
  ".next",
  "dist",
  ".turbo",
] as const;

export function projectExecutionTargetLabel(target: ProjectExecutionTarget): string {
  if (target.kind === "workspace-local") {
    return "This server";
  }
  return target.label?.trim() || target.host;
}

export function projectExecutionTargetDescription(target: ProjectExecutionTarget): string {
  if (target.kind === "workspace-local") {
    return "Runs directly on the workspace host.";
  }
  const usernamePrefix = target.username ? `${target.username}@` : "";
  const portSuffix = target.port ? `:${target.port}` : "";
  return `${usernamePrefix}${target.host}${portSuffix} via SSH + ${target.sync.mode}`;
}

export function serializeExecutionTargetIgnores(ignores: readonly string[]): string {
  return ignores.join("\n");
}

export function parseExecutionTargetIgnores(input: string): string[] {
  return input
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .filter((entry, index, all) => entry.length > 0 && all.indexOf(entry) === index);
}
