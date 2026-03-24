import { Encoding } from "effect";
import {
  CheckpointRef,
  ProjectId,
  type ProjectExecutionTarget,
  type ThreadId,
} from "@t3tools/contracts";

export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.makeUnsafe(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}

export function resolveExecutionWorkspaceCwd(input: {
  readonly workspaceRoot: string;
  readonly worktreePath: string | null;
  readonly executionTarget?: ProjectExecutionTarget;
}): string {
  const worktreeCwd = input.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  if (input.executionTarget?.kind === "ssh") {
    return input.executionTarget.sync.localPath;
  }

  return input.workspaceRoot;
}

export function resolveThreadWorkspaceCwd(input: {
  readonly thread: {
    readonly projectId: ProjectId;
    readonly worktreePath: string | null;
    readonly executionTarget?: ProjectExecutionTarget;
  };
  readonly projects: ReadonlyArray<{
    readonly id: ProjectId;
    readonly workspaceRoot: string;
  }>;
}): string | undefined {
  const worktreeCwd = input.thread.worktreePath ?? undefined;
  if (worktreeCwd) {
    return worktreeCwd;
  }

  const project = input.projects.find((entry) => entry.id === input.thread.projectId);
  if (!project) {
    return undefined;
  }

  return resolveExecutionWorkspaceCwd({
    workspaceRoot: project.workspaceRoot,
    worktreePath: input.thread.worktreePath,
    ...(input.thread.executionTarget ? { executionTarget: input.thread.executionTarget } : {}),
  });
}
