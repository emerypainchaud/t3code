import type { ProjectExecutionTarget } from "@t3tools/contracts";

function splitSegments(value: string): string[] {
  return value.split(/[/\\]+/).filter((segment) => segment.length > 0);
}

function joinLikeBase(basePath: string, segments: readonly string[]): string {
  const separator = basePath.includes("\\") ? "\\" : "/";
  const prefix = basePath.startsWith("\\\\") ? "\\\\" : basePath.startsWith("/") ? "/" : "";
  return `${prefix}${segments.join(separator)}`;
}

function relativeSegments(basePath: string, targetPath: string): string[] | null {
  const normalizedBase = basePath.trim().replace(/[\\/]+$/, "");
  const normalizedTarget = targetPath.trim().replace(/[\\/]+$/, "");
  const baseSegments = splitSegments(normalizedBase);
  const targetSegments = splitSegments(normalizedTarget);

  if (baseSegments.length > targetSegments.length) {
    return null;
  }
  for (let index = 0; index < baseSegments.length; index += 1) {
    if (baseSegments[index] !== targetSegments[index]) {
      return null;
    }
  }
  return targetSegments.slice(baseSegments.length);
}

function sanitizeWorktreeLeaf(branchName: string): string {
  return branchName.trim().replace(/[\\/]+/g, "-");
}

export function resolveSshRemotePathForLocalPath(
  executionTarget: Extract<ProjectExecutionTarget, { kind: "ssh" }>,
  localPath: string,
): string {
  const relative = relativeSegments(executionTarget.sync.localPath, localPath);
  if (!relative || relative.length === 0) {
    return executionTarget.remotePath;
  }
  return joinLikeBase(executionTarget.remotePath, [
    ...splitSegments(executionTarget.remotePath),
    ...relative,
  ]);
}

export function buildSshWorktreePath(
  executionTarget: Extract<ProjectExecutionTarget, { kind: "ssh" }>,
  branchName: string,
): string {
  const baseSegments = splitSegments(executionTarget.sync.localPath);
  return joinLikeBase(executionTarget.sync.localPath, [
    ...baseSegments,
    ".t3code",
    "worktrees",
    sanitizeWorktreeLeaf(branchName),
  ]);
}
