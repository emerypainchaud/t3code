import * as FS from "node:fs";
import * as Path from "node:path";

export const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
export const APP_SETTINGS_FILE_NAME = "app-settings.json";

function extractJsonObject(text: string, startIndex: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];
    if (character === undefined) {
      break;
    }

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }

    if (character === "{") {
      depth += 1;
      continue;
    }

    if (character !== "}") {
      continue;
    }

    depth -= 1;
    if (depth === 0) {
      return text.slice(startIndex, index + 1);
    }
  }

  return null;
}

export function extractLatestLegacyAppSettingsRawFromLevelDbText(text: string): string | null {
  let latestMatch: string | null = null;
  let latestNonEmptyWorkspaceMatch: string | null = null;
  let searchStartIndex = 0;

  while (searchStartIndex < text.length) {
    const keyIndex = text.indexOf(APP_SETTINGS_STORAGE_KEY, searchStartIndex);
    if (keyIndex === -1) {
      break;
    }

    const jsonStartIndex = text.indexOf("{", keyIndex + APP_SETTINGS_STORAGE_KEY.length);
    if (jsonStartIndex === -1) {
      break;
    }

    const candidate = extractJsonObject(text, jsonStartIndex);
    if (candidate !== null) {
      try {
        const parsed = JSON.parse(candidate) as { workspaces?: unknown };
        latestMatch = candidate;
        if (Array.isArray(parsed.workspaces) && parsed.workspaces.length > 0) {
          latestNonEmptyWorkspaceMatch = candidate;
        }
      } catch {
        // Ignore malformed legacy values and keep searching.
      }
      searchStartIndex = jsonStartIndex + 1;
      continue;
    }

    searchStartIndex = keyIndex + APP_SETTINGS_STORAGE_KEY.length;
  }

  return latestNonEmptyWorkspaceMatch ?? latestMatch;
}

function resolveAppSettingsFilePath(userDataPath: string): string {
  return Path.join(userDataPath, APP_SETTINGS_FILE_NAME);
}

function resolveLegacyLevelDbDirPath(userDataPath: string): string {
  return Path.join(userDataPath, "Local Storage", "leveldb");
}

function readFileIfExists(filePath: string): string | null {
  try {
    return FS.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function listLegacyLevelDbFiles(levelDbDirPath: string): string[] {
  try {
    return FS.readdirSync(levelDbDirPath)
      .filter((fileName) => fileName.endsWith(".log") || fileName.endsWith(".ldb"))
      .map((fileName) => Path.join(levelDbDirPath, fileName))
      .toSorted((leftPath, rightPath) => {
        const leftMtime = FS.statSync(leftPath).mtimeMs;
        const rightMtime = FS.statSync(rightPath).mtimeMs;
        return leftMtime - rightMtime;
      });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function loadLatestLegacyAppSettingsRaw(userDataPath: string): string | null {
  const levelDbDirPath = resolveLegacyLevelDbDirPath(userDataPath);
  let latestRaw: string | null = null;

  for (const filePath of listLegacyLevelDbFiles(levelDbDirPath)) {
    const contents = FS.readFileSync(filePath, "latin1");
    const candidate = extractLatestLegacyAppSettingsRawFromLevelDbText(contents);
    if (candidate !== null) {
      latestRaw = candidate;
    }
  }

  return latestRaw;
}

export function readPersistedAppSettingsRaw(userDataPath: string): string | null {
  const filePath = resolveAppSettingsFilePath(userDataPath);
  const persistedRaw = readFileIfExists(filePath);
  if (persistedRaw !== null) {
    return persistedRaw;
  }

  const legacyRaw = loadLatestLegacyAppSettingsRaw(userDataPath);
  if (legacyRaw !== null) {
    writePersistedAppSettingsRaw(userDataPath, legacyRaw);
  }
  return legacyRaw;
}

export function writePersistedAppSettingsRaw(
  userDataPath: string,
  raw: string | null | undefined,
): string | null {
  const filePath = resolveAppSettingsFilePath(userDataPath);
  const normalizedRaw = typeof raw === "string" && raw.length > 0 ? raw : null;

  FS.mkdirSync(Path.dirname(filePath), { recursive: true });
  if (normalizedRaw === null) {
    try {
      FS.rmSync(filePath, { force: true });
    } catch {
      // Best-effort persistence.
    }
    return null;
  }

  FS.writeFileSync(filePath, normalizedRaw, "utf8");
  return normalizedRaw;
}
