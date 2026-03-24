import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

const INTERNAL_DIR = ".t3code";
const MANAGED_MUTAGEN_DIR = path.join(INTERNAL_DIR, "bin");

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

export async function ensureManagedMutagenBinary(stateDir: string): Promise<string> {
  const targetPath = managedMutagenBinaryPath(stateDir);
  if (isExecutable(targetPath)) {
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
  return targetPath;
}
