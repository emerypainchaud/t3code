import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type {
  DesktopDeployRemoteWorkspaceInput,
  DesktopDeployRemoteWorkspaceResult,
} from "@t3tools/contracts";

const DEFAULT_SERVER_PORT = 3773;
const DEFAULT_SERVICE_NAME = "t3code-server";

type LinuxArch = DesktopDeployRemoteWorkspaceResult["remoteArch"];

interface RemoteWorkspaceDeploymentControllerOptions {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly appVersion: string;
  readonly embeddedBinaryRoots: readonly string[];
}

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

class RemoteWorkspaceDeploymentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RemoteWorkspaceDeploymentError";
  }
}

function assertNonEmpty(value: string, message: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new RemoteWorkspaceDeploymentError(message);
  }
  return trimmed;
}

function resolveServerPort(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SERVER_PORT;
  }
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new RemoteWorkspaceDeploymentError("Server port must be an integer between 1 and 65535.");
  }
  return value;
}

function resolveSshPort(value: number | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new RemoteWorkspaceDeploymentError("SSH port must be an integer between 1 and 65535.");
  }
  return value;
}

function resolveWorkspaceName(input: DesktopDeployRemoteWorkspaceInput): string {
  const explicit = input.workspaceName?.trim();
  if (explicit) {
    return explicit;
  }

  return input.connectHost?.trim() || input.host.trim();
}

function resolveSshTarget(input: DesktopDeployRemoteWorkspaceInput): string {
  const host = assertNonEmpty(input.host, "SSH host is required.");
  const username = input.username?.trim();
  return username ? `${username}@${host}` : host;
}

function baseSshArgs(input: DesktopDeployRemoteWorkspaceInput): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  const port = resolveSshPort(input.port);
  if (port !== undefined) {
    args.push("-p", String(port));
  }
  return args;
}

function baseScpArgs(input: DesktopDeployRemoteWorkspaceInput): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  const port = resolveSshPort(input.port);
  if (port !== undefined) {
    args.push("-P", String(port));
  }
  return args;
}

function detectLinuxArch(uname: string): LinuxArch {
  const normalized = uname.trim().toLowerCase();
  if (normalized === "x86_64" || normalized === "amd64") {
    return "x64";
  }
  if (normalized === "aarch64" || normalized === "arm64") {
    return "arm64";
  }

  throw new RemoteWorkspaceDeploymentError(
    `Unsupported remote architecture "${uname.trim()}". Expected x86_64/amd64 or aarch64/arm64.`,
  );
}

function targetForArch(arch: LinuxArch): string {
  return arch === "arm64" ? "bun-linux-arm64" : "bun-linux-x64";
}

function embeddedBinaryFileName(arch: LinuxArch): string {
  return `t3-server-linux-${arch}`;
}

function compileOutfile(stateDir: string, arch: LinuxArch): string {
  return Path.join(stateDir, "remote-workspace-artifacts", `t3-server-${arch}`);
}

async function runCommand(input: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly stdin?: string;
}): Promise<CommandResult> {
  const child = ChildProcess.spawn(input.command, [...input.args], {
    cwd: input.cwd,
    env: process.env,
    stdio: "pipe",
  });

  let stdout = "";
  let stderr = "";

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  if (input.stdin !== undefined) {
    child.stdin.end(input.stdin);
  } else {
    child.stdin.end();
  }

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
    throw new RemoteWorkspaceDeploymentError(detail);
  }

  return { stdout, stderr };
}

async function ensureServerCompileSource(repoRoot: string): Promise<string> {
  const entryPath = Path.join(repoRoot, "apps/server/src/index.ts");
  try {
    await FS.access(entryPath);
    return entryPath;
  } catch {
    throw new RemoteWorkspaceDeploymentError(
      "Remote workspace deployment currently requires a local repo checkout with apps/server/src/index.ts available.",
    );
  }
}

async function resolveEmbeddedServerBinary(
  roots: readonly string[],
  arch: LinuxArch,
): Promise<string | null> {
  const fileName = embeddedBinaryFileName(arch);

  for (const root of roots) {
    const candidate = Path.join(root, fileName);
    try {
      await FS.access(candidate);
      await FS.chmod(candidate, 0o755).catch(() => undefined);
      return candidate;
    } catch {
      // Try the next candidate root.
    }
  }

  return null;
}

async function compileServerBinary(input: {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly arch: LinuxArch;
}): Promise<string> {
  const entryPath = await ensureServerCompileSource(input.repoRoot);
  const outputPath = compileOutfile(input.stateDir, input.arch);
  await FS.mkdir(Path.dirname(outputPath), { recursive: true });
  await runCommand({
    command: "bun",
    args: [
      "build",
      "--compile",
      `--target=${targetForArch(input.arch)}`,
      entryPath,
      "--outfile",
      outputPath,
    ],
    cwd: input.repoRoot,
  });
  await FS.chmod(outputPath, 0o755);
  return outputPath;
}

async function resolveLocalServerBinary(input: {
  readonly repoRoot: string;
  readonly stateDir: string;
  readonly arch: LinuxArch;
  readonly embeddedBinaryRoots: readonly string[];
}): Promise<string> {
  const embeddedBinary = await resolveEmbeddedServerBinary(input.embeddedBinaryRoots, input.arch);
  if (embeddedBinary) {
    return embeddedBinary;
  }

  return compileServerBinary({
    repoRoot: input.repoRoot,
    stateDir: input.stateDir,
    arch: input.arch,
  });
}

function deploymentScript(): string {
  return `set -euo pipefail

TMP_BINARY="$1"
SERVER_PORT="$2"
AUTH_TOKEN="$3"
SERVICE_NAME="$4"
APP_VERSION="$5"
REMOTE_ARCH="$6"

INSTALL_ROOT="\${HOME}/.local/share/\${SERVICE_NAME}"
STATE_DIR="\${INSTALL_ROOT}/state"
SYSTEMD_DIR="\${HOME}/.config/systemd/user"
INSTALL_PATH="\${INSTALL_ROOT}/t3-server"
UNIT_PATH="\${SYSTEMD_DIR}/\${SERVICE_NAME}.service"
MANIFEST_PATH="\${INSTALL_ROOT}/deployment.json"

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl is required on the remote machine." >&2
  exit 1
fi

mkdir -p "\${INSTALL_ROOT}" "\${STATE_DIR}" "\${SYSTEMD_DIR}"
install -m 755 "\${TMP_BINARY}" "\${INSTALL_PATH}"
rm -f "\${TMP_BINARY}"

cat > "\${MANIFEST_PATH}" <<EOF
{"serviceName":"\${SERVICE_NAME}","version":"\${APP_VERSION}","arch":"\${REMOTE_ARCH}"}
EOF

cat > "\${UNIT_PATH}" <<EOF
[Unit]
Description=T3 Code Workspace Server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
ExecStart=\${INSTALL_PATH} --host 0.0.0.0 --port \${SERVER_PORT} --auth-token \${AUTH_TOKEN} --state-dir \${STATE_DIR} --no-browser
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now "\${SERVICE_NAME}.service" >/dev/null
systemctl --user restart "\${SERVICE_NAME}.service"
systemctl --user is-active --quiet "\${SERVICE_NAME}.service"

linger_value=""
if command -v loginctl >/dev/null 2>&1; then
  linger_value="$(loginctl show-user "$USER" -p Linger --value 2>/dev/null || true)"
fi

linger_json=null
if [[ "\${linger_value}" == "yes" ]]; then
  linger_json=true
elif [[ "\${linger_value}" == "no" ]]; then
  linger_json=false
fi

printf '{"serviceName":"%s","lingerEnabled":%s}\n' "\${SERVICE_NAME}" "\${linger_json}"
`;
}

export function createRemoteWorkspaceDeploymentController(
  options: RemoteWorkspaceDeploymentControllerOptions,
) {
  return {
    async deploy(
      input: DesktopDeployRemoteWorkspaceInput,
    ): Promise<DesktopDeployRemoteWorkspaceResult> {
      const host = assertNonEmpty(input.host, "SSH host is required.");
      const connectHost = input.connectHost?.trim() || host;
      const serverPort = resolveServerPort(input.serverPort);
      const workspaceName = resolveWorkspaceName(input);
      const sshTarget = resolveSshTarget(input);

      const remoteArchResult = await runCommand({
        command: "ssh",
        args: [...baseSshArgs(input), sshTarget, "uname", "-m"],
      });
      const remoteArch = detectLinuxArch(remoteArchResult.stdout);
      const localBinaryPath = await resolveLocalServerBinary({
        repoRoot: options.repoRoot,
        stateDir: options.stateDir,
        arch: remoteArch,
        embeddedBinaryRoots: options.embeddedBinaryRoots,
      });

      const tempToken = Crypto.randomBytes(6).toString("hex");
      const remoteTempPath = `/tmp/${DEFAULT_SERVICE_NAME}-${tempToken}`;
      const authToken = Crypto.randomBytes(24).toString("hex");

      await runCommand({
        command: "scp",
        args: [...baseScpArgs(input), localBinaryPath, `${sshTarget}:${remoteTempPath}`],
      });

      const installResult = await runCommand({
        command: "ssh",
        args: [
          ...baseSshArgs(input),
          sshTarget,
          "bash",
          "-s",
          "--",
          remoteTempPath,
          String(serverPort),
          authToken,
          DEFAULT_SERVICE_NAME,
          options.appVersion,
          remoteArch,
        ],
        stdin: deploymentScript(),
      });

      let parsed: { serviceName?: string; lingerEnabled?: boolean | null } = {};
      try {
        parsed = JSON.parse(installResult.stdout.trim()) as typeof parsed;
      } catch {
        parsed = {};
      }

      return {
        workspaceName,
        wsUrl: `ws://${connectHost}:${serverPort}`,
        authToken,
        serviceName: parsed.serviceName ?? DEFAULT_SERVICE_NAME,
        remoteArch,
        lingerEnabled:
          typeof parsed.lingerEnabled === "boolean" ? parsed.lingerEnabled : null,
      };
    },
  };
}
