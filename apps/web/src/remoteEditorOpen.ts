import type { EditorId, NativeApi, ProjectExecutionTarget } from "@t3tools/contracts";

import type { AppWorkspace } from "./appSettings";
import { resolveWorkspaceSshConnection } from "./appSettings";
import { resolveSshRemotePathForLocalPath } from "./sshExecutionPath";

export type OpenInTargetKind = "file" | "directory";

export interface OpenInEditorContext {
  workspace: AppWorkspace;
  executionTarget?: ProjectExecutionTarget | null | undefined;
  serverPath: string | null;
  targetKind: OpenInTargetKind;
  availableEditors: readonly EditorId[];
}

interface SshEditorTarget {
  host: string;
  username?: string;
  port?: number;
  remotePath: string;
}

const LOCAL_SSH_OPEN_EDITORS: readonly EditorId[] = ["cursor", "vscode", "zed"];

function isLocalSshEditorSupported(editor: EditorId): boolean {
  return LOCAL_SSH_OPEN_EDITORS.includes(editor);
}

function canUseDesktopLocalSshOpen(): boolean {
  return typeof window !== "undefined" && Boolean(window.desktopBridge);
}

function resolveSshEditorTarget(input: OpenInEditorContext): SshEditorTarget | null {
  if (input.executionTarget?.kind === "ssh") {
    return {
      host: input.executionTarget.host,
      ...(input.executionTarget.username ? { username: input.executionTarget.username } : {}),
      ...(input.executionTarget.port !== undefined ? { port: input.executionTarget.port } : {}),
      remotePath:
        input.serverPath !== null
          ? resolveSshRemotePathForLocalPath(input.executionTarget, input.serverPath)
          : input.executionTarget.remotePath,
    };
  }

  if (input.workspace.isLocal || !input.serverPath) {
    return null;
  }

  const workspaceSshConnection = resolveWorkspaceSshConnection(input.workspace);
  if (!workspaceSshConnection) {
    return null;
  }

  return {
    ...workspaceSshConnection,
    remotePath: input.serverPath,
  };
}

export function resolveOpenInEditorOptions(
  input: Pick<
    OpenInEditorContext,
    "workspace" | "executionTarget" | "serverPath" | "availableEditors"
  >,
): EditorId[] {
  const options = new Set(input.availableEditors);
  const sshTarget = resolveSshEditorTarget({
    ...input,
    targetKind: "directory",
  });
  if (sshTarget && canUseDesktopLocalSshOpen()) {
    for (const editor of LOCAL_SSH_OPEN_EDITORS) {
      options.add(editor);
    }
  }
  return Array.from(options);
}

export async function openInEditorWithContext(
  api: NativeApi,
  editor: EditorId,
  input: OpenInEditorContext,
): Promise<void> {
  if (input.serverPath === null) {
    throw new Error("No path is available to open in an editor.");
  }

  const sshTarget = resolveSshEditorTarget(input);
  if (!sshTarget || !canUseDesktopLocalSshOpen() || !isLocalSshEditorSupported(editor)) {
    await api.shell.openInEditor(input.serverPath, editor);
    return;
  }

  const localOpenResult = await api.shell.openInLocalEditorViaSsh({
    editor,
    host: sshTarget.host,
    ...(sshTarget.username ? { username: sshTarget.username } : {}),
    ...(sshTarget.port !== undefined ? { port: sshTarget.port } : {}),
    remotePath: sshTarget.remotePath,
    targetKind: input.targetKind,
  });
  if (localOpenResult.opened) {
    return;
  }

  if (input.availableEditors.includes(editor)) {
    await api.shell.openInEditor(input.serverPath, editor);
    return;
  }

  throw new Error(
    localOpenResult.command
      ? `${localOpenResult.message}\n\nTry:\n${localOpenResult.command}`
      : localOpenResult.message,
  );
}
