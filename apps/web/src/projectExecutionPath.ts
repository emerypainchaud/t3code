import type { ProjectExecutionTarget } from "@t3tools/contracts";

import type { Project } from "./types";

function normalizePath(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function resolveProjectExecutionRoot(
  project: Pick<Project, "cwd" | "executionTarget">,
): string {
  return project.executionTarget.kind === "ssh"
    ? project.executionTarget.sync.localPath
    : project.cwd;
}

export function resolveExecutionCwd(input: {
  readonly project: Pick<Project, "cwd" | "executionTarget"> | null | undefined;
  readonly worktreePath: string | null | undefined;
}): string | null {
  const worktreePath = normalizePath(input.worktreePath);
  if (worktreePath) {
    return worktreePath;
  }
  return input.project ? resolveProjectExecutionRoot(input.project) : null;
}

export function resolveDraftExecutionTarget(input: {
  readonly project: Pick<Project, "executionTarget"> | null | undefined;
}): ProjectExecutionTarget {
  return input.project?.executionTarget ?? { kind: "workspace-local" };
}
