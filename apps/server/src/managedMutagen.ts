import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const INTERNAL_DIR = ".t3code";
const MANAGED_MUTAGEN_DIR = path.join(INTERNAL_DIR, "bin");
const MANAGED_MUTAGEN_LIBEXEC_DIR = path.join(INTERNAL_DIR, "libexec");
const MUTAGEN_AGENT_ARCHIVE_NAME = "mutagen-agents.tar.gz";

function managedMutagenFileName(): string {
  return process.platform === "win32" ? "mutagen.exe" : "mutagen";
}

function resolvePathEntries(env: NodeJS.ProcessEnv = process.env): string[] {
  const rawPath = env.PATH ?? env.Path ?? env.path ?? "";
  if (!rawPath) {
    return [];
  }
  return rawPath
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function isExecutable(filePath: string): boolean {
  try {
    fs.accessSync(filePath, process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveSystemMutagenPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const binaryName = managedMutagenFileName();
  for (const entry of resolvePathEntries(env)) {
    const candidate = path.join(entry, binaryName);
    if (isExecutable(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function managedMutagenBinaryPath(stateDir: string): string {
  return path.join(stateDir, MANAGED_MUTAGEN_DIR, managedMutagenFileName());
}

function managedMutagenLibexecPath(stateDir: string): string {
  return path.join(stateDir, MANAGED_MUTAGEN_LIBEXEC_DIR);
}

function managedMutagenAgentArchivePath(stateDir: string): string {
  return path.join(stateDir, MANAGED_MUTAGEN_DIR, MUTAGEN_AGENT_ARCHIVE_NAME);
}

function resolveSystemMutagenLibexecPath(sourceBinaryPath: string): string | null {
  const candidates = [
    path.resolve(path.dirname(sourceBinaryPath), "..", "libexec"),
    path.resolve(path.dirname(sourceBinaryPath), "libexec"),
  ];

  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) {
        return candidate;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return null;
}

function resolveSystemMutagenAgentArchivePath(sourceBinaryPath: string): string | null {
  const candidate = path.join(path.dirname(sourceBinaryPath), MUTAGEN_AGENT_ARCHIVE_NAME);
  try {
    const stat = fs.statSync(candidate);
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

async function ensureManagedMutagenLibexec(
  stateDir: string,
  sourceBinaryPath: string,
): Promise<void> {
  const sourceLibexecPath = resolveSystemMutagenLibexecPath(sourceBinaryPath);
  if (!sourceLibexecPath) {
    return;
  }

  const targetLibexecPath = managedMutagenLibexecPath(stateDir);
  try {
    const stat = await fsp.stat(targetLibexecPath);
    if (stat.isDirectory()) {
      return;
    }
  } catch {
    // Copy below.
  }

  await fsp.mkdir(path.dirname(targetLibexecPath), { recursive: true });
  await fsp.cp(sourceLibexecPath, targetLibexecPath, {
    recursive: true,
    force: true,
  });
}

async function ensureManagedMutagenAgentArchive(
  stateDir: string,
  sourceBinaryPath: string,
): Promise<void> {
  const sourceArchivePath = resolveSystemMutagenAgentArchivePath(sourceBinaryPath);
  if (!sourceArchivePath) {
    return;
  }

  const targetArchivePath = managedMutagenAgentArchivePath(stateDir);
  try {
    const stat = await fsp.stat(targetArchivePath);
    if (stat.isFile() && stat.size > 0) {
      return;
    }
  } catch {
    // Copy below.
  }

  await fsp.mkdir(path.dirname(targetArchivePath), { recursive: true });
  await fsp.copyFile(sourceArchivePath, targetArchivePath);
}

export async function ensureManagedMutagenBinary(stateDir: string): Promise<string> {
  const targetPath = managedMutagenBinaryPath(stateDir);
  if (isExecutable(targetPath)) {
    const sourcePath = resolveSystemMutagenPath();
    if (sourcePath) {
      await ensureManagedMutagenLibexec(stateDir, sourcePath);
      await ensureManagedMutagenAgentArchive(stateDir, sourcePath);
    }
    return targetPath;
  }

  const sourcePath = resolveSystemMutagenPath();
  if (!sourcePath) {
    throw new Error("Mutagen is not installed and no managed T3 copy is available.");
  }

  await fsp.mkdir(path.dirname(targetPath), { recursive: true });
  await fsp.copyFile(sourcePath, targetPath);
  if (process.platform !== "win32") {
    await fsp.chmod(targetPath, 0o755);
  }
  await ensureManagedMutagenLibexec(stateDir, sourcePath);
  await ensureManagedMutagenAgentArchive(stateDir, sourcePath);
  return targetPath;
}
