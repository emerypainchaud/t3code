import { EditorId, type ProjectExecutionTarget, type ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { memo, useCallback, useEffect, useMemo } from "react";
import { isOpenFavoriteEditorShortcut, shortcutLabelForCommand } from "../../keybindings";
import { usePreferredEditor } from "../../editorPreferences";
import { ChevronDownIcon, FolderClosedIcon } from "lucide-react";
import { Button } from "../ui/button";
import { Group, GroupSeparator } from "../ui/group";
import { Menu, MenuItem, MenuPopup, MenuShortcut, MenuTrigger } from "../ui/menu";
import { AntigravityIcon, CursorIcon, Icon, VisualStudioCode, Zed } from "../Icons";
import { isMacPlatform, isWindowsPlatform } from "~/lib/utils";
import { readNativeApi } from "~/nativeApi";
import type { AppWorkspace } from "~/appSettings";
import { openInEditorWithContext, resolveOpenInEditorOptions } from "~/remoteEditorOpen";
import { toastManager } from "../ui/toast";

const resolveOptions = (platform: string, availableEditors: ReadonlyArray<EditorId>) => {
  const baseOptions: ReadonlyArray<{ label: string; Icon: Icon; value: EditorId }> = [
    {
      label: "Cursor",
      Icon: CursorIcon,
      value: "cursor",
    },
    {
      label: "VS Code",
      Icon: VisualStudioCode,
      value: "vscode",
    },
    {
      label: "Zed",
      Icon: Zed,
      value: "zed",
    },
    {
      label: "Antigravity",
      Icon: AntigravityIcon,
      value: "antigravity",
    },
    {
      label: isMacPlatform(platform)
        ? "Finder"
        : isWindowsPlatform(platform)
          ? "Explorer"
          : "Files",
      Icon: FolderClosedIcon,
      value: "file-manager",
    },
  ];
  return baseOptions.filter((option) => availableEditors.includes(option.value));
};

export const OpenInPicker = memo(function OpenInPicker({
  keybindings,
  availableEditors: serverAvailableEditors,
  openInCwd: serverPath,
  workspace,
  executionTarget,
  targetKind,
}: {
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  openInCwd: string | null;
  workspace: AppWorkspace;
  executionTarget?: ProjectExecutionTarget | null | undefined;
  targetKind: "file" | "directory";
}) {
  const availableEditors = useMemo(
    () =>
      resolveOpenInEditorOptions({
        workspace,
        executionTarget,
        serverPath,
        availableEditors: serverAvailableEditors,
      }),
    [executionTarget, serverAvailableEditors, serverPath, workspace],
  );
  const [preferredEditor, setPreferredEditor] = usePreferredEditor(availableEditors);
  const options = useMemo(
    () => resolveOptions(navigator.platform, availableEditors),
    [availableEditors],
  );
  const primaryOption = options.find(({ value }) => value === preferredEditor) ?? null;

  const openInEditor = useCallback(
    (editorId: EditorId | null) => {
      const api = readNativeApi();
      if (!api || !serverPath) return;
      const editor = editorId ?? preferredEditor;
      if (!editor) return;
      void openInEditorWithContext(api, editor, {
        workspace,
        executionTarget,
        serverPath,
        targetKind,
        availableEditors: serverAvailableEditors,
      }).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open in editor",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      });
      setPreferredEditor(editor);
    },
    [executionTarget, preferredEditor, serverAvailableEditors, serverPath, setPreferredEditor, targetKind, workspace],
  );

  const openFavoriteEditorShortcutLabel = useMemo(
    () => shortcutLabelForCommand(keybindings, "editor.openFavorite"),
    [keybindings],
  );

  useEffect(() => {
    const handler = (e: globalThis.KeyboardEvent) => {
      const api = readNativeApi();
      if (!isOpenFavoriteEditorShortcut(e, keybindings)) return;
      if (!api || !serverPath) return;
      if (!preferredEditor) return;

      e.preventDefault();
      void openInEditorWithContext(api, preferredEditor, {
        workspace,
        executionTarget,
        serverPath,
        targetKind,
        availableEditors: serverAvailableEditors,
      }).catch((error) => {
        toastManager.add({
          type: "error",
          title: "Unable to open in editor",
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      });
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [executionTarget, keybindings, preferredEditor, serverAvailableEditors, serverPath, targetKind, workspace]);

  return (
    <Group aria-label="Subscription actions">
      <Button
        size="xs"
        variant="outline"
        disabled={!preferredEditor || !serverPath}
        onClick={() => openInEditor(preferredEditor)}
      >
        {primaryOption?.Icon && <primaryOption.Icon aria-hidden="true" className="size-3.5" />}
        <span className="sr-only @sm/header-actions:not-sr-only @sm/header-actions:ml-0.5">
          Open
        </span>
      </Button>
      <GroupSeparator className="hidden @sm/header-actions:block" />
      <Menu>
        <MenuTrigger render={<Button aria-label="Copy options" size="icon-xs" variant="outline" />}>
          <ChevronDownIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {options.length === 0 && <MenuItem disabled>No installed editors found</MenuItem>}
          {options.map(({ label, Icon, value }) => (
            <MenuItem key={value} onClick={() => openInEditor(value)}>
              <Icon aria-hidden="true" className="text-muted-foreground" />
              {label}
              {value === preferredEditor && openFavoriteEditorShortcutLabel && (
                <MenuShortcut>{openFavoriteEditorShortcutLabel}</MenuShortcut>
              )}
            </MenuItem>
          ))}
        </MenuPopup>
      </Menu>
    </Group>
  );
});
