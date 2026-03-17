import type { NativeApi, ProjectExecutionTarget } from "@t3tools/contracts";
import { EDITORS, EditorId } from "@t3tools/contracts";
import { getLocalStorageItem, setLocalStorageItem, useLocalStorage } from "./hooks/useLocalStorage";
import { useMemo } from "react";
import type { AppWorkspace } from "./appSettings";
import { openInEditorWithContext, resolveOpenInEditorOptions, type OpenInTargetKind } from "./remoteEditorOpen";

const LAST_EDITOR_KEY = "t3code:last-editor";

export function usePreferredEditor(availableEditors: ReadonlyArray<EditorId>) {
  const [lastEditor, setLastEditor] = useLocalStorage(LAST_EDITOR_KEY, null, EditorId);

  const effectiveEditor = useMemo(() => {
    if (lastEditor && availableEditors.includes(lastEditor)) return lastEditor;
    return EDITORS.find((editor) => availableEditors.includes(editor.id))?.id ?? null;
  }, [lastEditor, availableEditors]);

  return [effectiveEditor, setLastEditor] as const;
}

export function resolveAndPersistPreferredEditor(
  availableEditors: readonly EditorId[],
): EditorId | null {
  const availableEditorIds = new Set(availableEditors);
  const stored = getLocalStorageItem(LAST_EDITOR_KEY, EditorId);
  if (stored && availableEditorIds.has(stored)) return stored;
  const editor = EDITORS.find((editor) => availableEditorIds.has(editor.id))?.id ?? null;
  if (editor) setLocalStorageItem(LAST_EDITOR_KEY, editor, EditorId);
  return editor ?? null;
}

export interface PreferredEditorOpenContext {
  workspace?: AppWorkspace;
  executionTarget?: ProjectExecutionTarget | null | undefined;
  targetKind?: OpenInTargetKind;
}

export async function openInPreferredEditor(
  api: NativeApi,
  targetPath: string,
  context?: PreferredEditorOpenContext,
): Promise<EditorId> {
  const { availableEditors } = await api.server.getConfig();
  const effectiveEditors =
    context?.workspace !== undefined
      ? resolveOpenInEditorOptions({
          workspace: context.workspace,
          executionTarget: context.executionTarget,
          serverPath: targetPath,
          availableEditors,
        })
      : [...availableEditors];
  const editor = resolveAndPersistPreferredEditor(effectiveEditors);
  if (!editor) throw new Error("No available editors found.");
  if (context?.workspace) {
    await openInEditorWithContext(api, editor, {
      workspace: context.workspace,
      executionTarget: context.executionTarget,
      serverPath: targetPath,
      targetKind: context.targetKind ?? "file",
      availableEditors,
    });
  } else {
    await api.shell.openInEditor(targetPath, editor);
  }
  return editor;
}
