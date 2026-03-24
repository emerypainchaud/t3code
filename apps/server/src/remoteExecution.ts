import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  ProjectExecutionTarget,
  ProviderKind,
  ProviderSessionStartInput,
} from "@t3tools/contracts";
import { REMOTE_SHELL_SCRIPT_FALLBACK } from "./remoteShellScript.ts";

const REMOTE_EXECUTION_DIR = "remote-execution";
const REMOTE_SHELL_SCRIPT_NAME = "t3-remote-shell.sh";
const LOCAL_FALLBACK_SHELL = "/bin/bash";
const REMOTE_SHELL_SCRIPT = (() => {
  try {
    return fs.readFileSync(new URL("./remote-shell.sh", import.meta.url), "utf8");
  } catch {
    return REMOTE_SHELL_SCRIPT_FALLBACK;
  }
})();

function ensureExecutableFile(filePath: string, contents: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const currentContents = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
  if (currentContents !== contents) {
    fs.writeFileSync(filePath, contents, "utf8");
  }
  fs.chmodSync(filePath, 0o755);
}

function remoteExecutionStateDir(
  stateDir: string,
  target: Extract<ProjectExecutionTarget, { kind: "ssh" }>,
) {
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      JSON.stringify({
        host: target.host,
        port: target.port ?? 22,
        username: target.username ?? null,
        remotePath: target.remotePath,
        localPath: target.sync.localPath,
      }),
    )
    .digest("hex")
    .slice(0, 12);
  return path.join(stateDir, REMOTE_EXECUTION_DIR, fingerprint);
}

function remoteExecutionSessionName(target: Extract<ProjectExecutionTarget, { kind: "ssh" }>) {
  const raw = `${target.username ?? "user"}-${target.host}-${target.port ?? 22}-${target.remotePath}`;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  const suffix = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `t3-${normalized || "remote"}-${suffix}`;
}

export function remoteExecutionMutagenLabelSelector(
  target: Extract<ProjectExecutionTarget, { kind: "ssh" }>,
): string {
  return `t3-session=${remoteExecutionSessionName(target)}`;
}

export function ensureRemoteShellScript(stateDir: string): string {
  const scriptPath = path.join(stateDir, REMOTE_EXECUTION_DIR, REMOTE_SHELL_SCRIPT_NAME);
  ensureExecutableFile(scriptPath, REMOTE_SHELL_SCRIPT);
  return scriptPath;
}

export function buildRemoteTerminalEnvironment(input: {
  readonly stateDir: string;
  readonly target: Extract<ProjectExecutionTarget, { kind: "ssh" }>;
  readonly mutagenBin?: string;
}): Record<string, string> {
  const targetStateDir = remoteExecutionStateDir(input.stateDir, input.target);
  fs.mkdirSync(targetStateDir, { recursive: true });
  return {
    T3_LOCAL_SHELL: LOCAL_FALLBACK_SHELL,
    T3_REMOTE_HOST: input.target.host,
    ...(input.target.port !== undefined ? { T3_REMOTE_PORT: String(input.target.port) } : {}),
    ...(input.target.username ? { T3_REMOTE_USER: input.target.username } : {}),
    T3_REMOTE_PATH: input.target.remotePath,
    T3_LOCAL_PATH: input.target.sync.localPath,
    T3_MUTAGEN_LABEL_SELECTOR: remoteExecutionMutagenLabelSelector(input.target),
    T3_REMOTE_STATE_DIR: targetStateDir,
    ...(input.mutagenBin ? { T3_MUTAGEN_BIN: input.mutagenBin } : {}),
  };
}

export function buildRemoteProviderOptions(input: {
  readonly stateDir: string;
  readonly provider: ProviderKind;
  readonly target: ProjectExecutionTarget;
  readonly mutagenBin?: string;
}): ProviderSessionStartInput["providerOptions"] | undefined {
  if (input.target.kind !== "ssh") {
    return undefined;
  }

  const scriptPath = ensureRemoteShellScript(input.stateDir);
  const shellEnvironment = buildRemoteTerminalEnvironment({
    stateDir: input.stateDir,
    target: input.target,
    ...(input.mutagenBin ? { mutagenBin: input.mutagenBin } : {}),
  });

  if (input.provider === "claudeCode") {
    return {
      claudeCode: {
        shellPath: scriptPath,
        shellEnvironment,
      },
    };
  }

  return {
    codex: {
      shellPath: scriptPath,
      shellEnvironment,
    },
  };
}
