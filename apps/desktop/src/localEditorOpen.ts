import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import type { DesktopOpenInLocalEditorViaSshInput, DesktopOpenInLocalEditorViaSshResult, EditorId } from "@t3tools/contracts";

const LINE_COLUMN_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

interface NormalizedRemotePath {
  path: string;
  lineSuffix: string;
}

function quoteShellArg(value: string): string {
  return /\s/.test(value) ? JSON.stringify(value) : value;
}

function commandPreview(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteShellArg).join(" ");
}

function commandPathCandidates(command: string): string[] {
  const pathEntries = (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const platformCandidates =
    process.platform === "darwin" ? [`/opt/homebrew/bin/${command}`, `/usr/local/bin/${command}`] : [];
  return [...new Set([...platformCandidates, ...pathEntries.map((entry) => `${entry}/${command}`)])];
}

function isCommandAvailable(command: string): boolean {
  return commandPathCandidates(command).some((candidate) => existsSync(candidate));
}

function resolveLocalEditorCommand(command: string): string {
  return commandPathCandidates(command).find((candidate) => existsSync(candidate)) ?? command;
}

function normalizeRemotePath(targetPath: string): NormalizedRemotePath {
  const match = targetPath.match(LINE_COLUMN_SUFFIX_PATTERN);
  return {
    path: targetPath.replace(LINE_COLUMN_SUFFIX_PATTERN, ""),
    lineSuffix: match?.[0] ?? "",
  };
}

function buildSshAuthority(input: DesktopOpenInLocalEditorViaSshInput): string {
  return input.username?.trim() || input.port !== undefined
    ? `${input.username?.trim() ? `${input.username.trim()}@` : ""}${input.host}${
        input.port !== undefined ? `:${input.port}` : ""
      }`
    : input.host;
}

function buildVsCodeRemoteUri(input: DesktopOpenInLocalEditorViaSshInput): string {
  const authority = buildSshAuthority(input);
  const normalizedRemotePath = normalizeRemotePath(input.remotePath);
  const encodedPath = normalizedRemotePath.path
    .split("/")
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join("/");
  return `vscode-remote://ssh-remote+${authority}${encodedPath}`;
}

function buildCursorRemoteSpecifier(input: DesktopOpenInLocalEditorViaSshInput): string {
  return `ssh-remote+${buildSshAuthority(input)}`;
}

function buildZedRemoteUrl(input: DesktopOpenInLocalEditorViaSshInput): string {
  const normalizedRemotePath = normalizeRemotePath(input.remotePath);
  const encodedPath = normalizedRemotePath.path
    .split("/")
    .map((segment, index) => (index === 0 ? segment : encodeURIComponent(segment)))
    .join("/");
  return `ssh://${buildSshAuthority(input)}${encodedPath}${normalizedRemotePath.lineSuffix}`;
}

const LOCAL_SSH_OPEN_EDITOR_COMMANDS: Record<EditorId, string | null> = {
  cursor: "cursor",
  vscode: "code",
  zed: "zed",
  antigravity: null,
  "file-manager": null,
};

export function getAvailableLocalSshOpenEditors(): EditorId[] {
  return (Object.entries(LOCAL_SSH_OPEN_EDITOR_COMMANDS) as Array<[EditorId, string | null]>)
    .filter((entry): entry is [EditorId, string] => entry[1] !== null)
    .filter(([, command]) => isCommandAvailable(command))
    .map(([editor]) => editor);
}

export function buildLocalEditorViaSshLaunch(
  input: DesktopOpenInLocalEditorViaSshInput,
): { command: string; args: string[] } | null {
  const normalizedRemotePath = normalizeRemotePath(input.remotePath);
  switch (input.editor) {
    case "vscode":
      return {
        command: "code",
        args: [
          input.targetKind === "directory" ? "--folder-uri" : "--file-uri",
          buildVsCodeRemoteUri(input),
        ],
      };
    case "cursor":
      return {
        command: "cursor",
        args:
          input.targetKind === "directory"
            ? ["--remote", buildCursorRemoteSpecifier(input), normalizedRemotePath.path]
            : [
                "--remote",
                buildCursorRemoteSpecifier(input),
                "--goto",
                `${normalizedRemotePath.path}${normalizedRemotePath.lineSuffix}`,
              ],
      };
    case "zed":
      return {
        command: "zed",
        args: [buildZedRemoteUrl(input)],
      };
    default:
      return null;
  }
}

export async function openInLocalEditorViaSsh(
  input: DesktopOpenInLocalEditorViaSshInput,
): Promise<DesktopOpenInLocalEditorViaSshResult> {
  const launch = buildLocalEditorViaSshLaunch(input);
  if (!launch) {
    return {
      opened: false,
      message:
        "This editor does not support local SSH open in T3 Code yet. Try remote-host launch instead.",
    };
  }

  return new Promise<DesktopOpenInLocalEditorViaSshResult>((resolve) => {
    let child;
    const resolvedCommand = resolveLocalEditorCommand(launch.command);
    try {
      child = spawn(resolvedCommand, launch.args, {
        detached: true,
        stdio: "ignore",
        shell: process.platform === "win32",
      });
    } catch (error) {
      resolve({
        opened: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to launch the local editor for this SSH target.",
        command: commandPreview(resolvedCommand, launch.args),
      });
      return;
    }

    child.once("spawn", () => {
      child.unref();
      resolve({
        opened: true,
        message: "Opened in local editor.",
      });
    });
    child.once("error", (error) => {
      resolve({
        opened: false,
        message:
          error instanceof Error
            ? error.message
            : "Unable to launch the local editor for this SSH target.",
        command: commandPreview(resolvedCommand, launch.args),
      });
    });
  });
}
