import crypto from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type {
  ProjectListDirectoryResult,
  ProjectSshCreateDirectoryInput,
  ProjectSshDirectoryListInput,
  ProjectSshPreflightInput,
  ProjectSshPreflightResult,
} from "@t3tools/contracts";

import { runProcess } from "./processRunner.ts";
import { ensureManagedMutagenBinary } from "./managedMutagen.ts";

const SSH_TIMEOUT_MS = 5_000;
const SSH_MAX_BUFFER_BYTES = 256 * 1024;
const PROJECT_MIRRORS_DIR = "project-mirrors";

function quoteForShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizePort(port: number | undefined): number {
  return port ?? 22;
}

function buildRemoteTarget(input: { host: string; username?: string | undefined }): string {
  return input.username ? `${input.username}@${input.host}` : input.host;
}

function buildSshArgs(
  input: {
    host: string;
    username?: string | undefined;
    port?: number | undefined;
  },
  remoteCommand: string,
): string[] {
  return [
    "-o",
    "BatchMode=yes",
    "-o",
    `ConnectTimeout=${Math.floor(SSH_TIMEOUT_MS / 1000)}`,
    ...(input.port !== undefined ? ["-p", String(input.port)] : []),
    buildRemoteTarget(input),
    remoteCommand,
  ];
}

async function runSshCommand(
  input: {
    host: string;
    username?: string | undefined;
    port?: number | undefined;
  },
  remoteCommand: string,
) {
  return runProcess("ssh", buildSshArgs(input, remoteCommand), {
    allowNonZeroExit: true,
    timeoutMs: SSH_TIMEOUT_MS,
    outputMode: "truncate",
    maxBufferBytes: SSH_MAX_BUFFER_BYTES,
  });
}

function parseBooleanProbeOutput(stdout: string, key: string): boolean {
  const pattern = new RegExp(`(?:^|\\n)${key}=(true|false)(?:\\n|$)`);
  const match = stdout.match(pattern);
  return match?.[1] === "true";
}

function sanitizeMirrorSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "project";
}

function expandHomePath(input: string): string {
  return input.startsWith("~/") ? path.join(os.homedir(), input.slice(2)) : input;
}

function mirrorLeafName(remotePath: string): string {
  const trimmed = remotePath.replace(/\/+$/g, "");
  return path.posix.basename(trimmed) || "project";
}

export function suggestProjectMirrorPath(
  stateDir: string,
  input: Pick<ProjectSshPreflightInput, "host" | "username" | "port" | "remotePath">,
): string {
  const identity = JSON.stringify({
    host: input.host,
    username: input.username ?? null,
    port: normalizePort(input.port),
  });
  const suffix = crypto.createHash("sha256").update(identity).digest("hex").slice(0, 8);
  const hostSegment = sanitizeMirrorSegment(
    `${input.username ?? "user"}-${input.host}-${normalizePort(input.port)}`,
  );
  const leafSegment = sanitizeMirrorSegment(mirrorLeafName(input.remotePath));
  return path.join(stateDir, PROJECT_MIRRORS_DIR, `${hostSegment}-${suffix}`, leafSegment);
}

function resolveMirrorPath(stateDir: string, input: ProjectSshPreflightInput): string {
  const chosen = input.localPathOverride?.trim() || suggestProjectMirrorPath(stateDir, input);
  return path.resolve(expandHomePath(chosen));
}

function resolveDirectoryParent(directoryPath: string): string | null {
  const normalized = path.posix.normalize(directoryPath);
  if (normalized === "/") {
    return null;
  }
  const parent = path.posix.dirname(normalized);
  return parent === normalized ? null : parent;
}

export async function listSshDirectories(
  input: ProjectSshDirectoryListInput,
): Promise<ProjectListDirectoryResult> {
  const remoteEntryLimit = Math.max(1, input.limit + 1);
  const command = [
    `cd -- ${quoteForShell(input.path)}`,
    "pwd -P",
    "printf '\\0'",
    `find . -mindepth 1 -maxdepth 1 -type d -printf '%P\\0' | head -z -n ${String(remoteEntryLimit)}`,
  ].join(" && ");
  const result = await runSshCommand(input, command);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || result.stdout.trim() || "Unable to browse SSH target.");
  }

  const parts = result.stdout.split("\0");
  const directoryPath = parts.shift()?.trim();
  if (!directoryPath) {
    throw new Error("SSH target directory listing was empty.");
  }

  const rawEntries = parts.filter((entry) => entry.trim().length > 0);
  const entries = rawEntries.slice(0, input.limit).map((name) => ({
    name,
    path: path.posix.join(directoryPath, name),
    parentPath: directoryPath,
  }));

  return {
    directoryPath,
    parentPath: resolveDirectoryParent(directoryPath),
    entries,
    truncated: rawEntries.length > input.limit,
  };
}

export async function createSshDirectory(
  input: ProjectSshCreateDirectoryInput,
): Promise<ProjectListDirectoryResult> {
  const targetPath = path.posix.join(input.path, input.name);
  const result = await runSshCommand(
    input,
    `mkdir -p -- ${quoteForShell(targetPath)} && cd -- ${quoteForShell(targetPath)} && pwd -P`,
  );
  if (result.code !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || "Unable to create SSH directory.",
    );
  }

  return listSshDirectories({
    host: input.host,
    ...(input.username ? { username: input.username } : {}),
    ...(input.port !== undefined ? { port: input.port } : {}),
    path: targetPath,
    limit: 200,
  });
}

async function canWriteLocalMirrorPath(localPath: string): Promise<boolean> {
  try {
    await fs.mkdir(localPath, { recursive: true });
    await fs.access(localPath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function preflightSshTarget(
  stateDir: string,
  input: ProjectSshPreflightInput,
): Promise<ProjectSshPreflightResult> {
  const resolvedLocalPath = resolveMirrorPath(stateDir, input);
  const errors: string[] = [];

  const sshProbe = await runSshCommand(
    input,
    [
      `if [ -d ${quoteForShell(input.remotePath)} ]; then printf 'remotePathExists=true\\n'; else printf 'remotePathExists=false\\n'; fi`,
      "if test -x /bin/bash || command -v bash >/dev/null 2>&1 || test -x /bin/sh; then printf 'remoteShellReady=true\\n'; else printf 'remoteShellReady=false\\n'; fi",
    ].join("; "),
  );
  const sshReachable = sshProbe.code === 0;
  if (!sshReachable) {
    errors.push(sshProbe.stderr.trim() || sshProbe.stdout.trim() || "Unable to reach SSH host.");
  }

  let remotePathExists = false;
  let remoteShellReady = false;
  if (sshReachable) {
    remotePathExists = parseBooleanProbeOutput(sshProbe.stdout, "remotePathExists");
    if (!remotePathExists) {
      errors.push(`Remote path is missing or not a directory: ${input.remotePath}`);
    }

    remoteShellReady = parseBooleanProbeOutput(sshProbe.stdout, "remoteShellReady");
    if (!remoteShellReady) {
      errors.push("Remote shell is unavailable. Install bash or ensure /bin/sh exists.");
    }
  }

  let mutagenInstalled = false;
  try {
    const managedMutagenPath = await ensureManagedMutagenBinary(stateDir);
    const mutagenProbe = await runProcess(managedMutagenPath, ["version"], {
      allowNonZeroExit: true,
      timeoutMs: SSH_TIMEOUT_MS,
      outputMode: "truncate",
      maxBufferBytes: SSH_MAX_BUFFER_BYTES,
    });
    mutagenInstalled = mutagenProbe.code === 0;
    if (!mutagenInstalled) {
      errors.push("Managed Mutagen is unavailable on the T3 server.");
    }
  } catch (error) {
    errors.push(
      error instanceof Error ? error.message : "Mutagen is unavailable on the T3 server.",
    );
  }

  const localPathWritable = await canWriteLocalMirrorPath(resolvedLocalPath);
  if (!localPathWritable) {
    errors.push(`Local mirror path is not writable: ${resolvedLocalPath}`);
  }

  return {
    suggestedLocalPath: suggestProjectMirrorPath(stateDir, input),
    resolvedLocalPath,
    sshReachable,
    remotePathExists,
    mutagenInstalled,
    localPathWritable,
    remoteShellReady,
    errors: errors.slice(0, 8),
  };
}
