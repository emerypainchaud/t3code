import type { PersistStorage, StorageValue } from "zustand/middleware";

import { getAppSettingsSnapshot, resolveActiveWorkspace } from "./appSettings";

function activeWorkspaceStorageSuffix(): string {
  return resolveActiveWorkspace(getAppSettingsSnapshot()).id;
}

export function workspaceScopedStorageKey(baseKey: string): string {
  return `${baseKey}:${activeWorkspaceStorageSuffix()}`;
}

export function createWorkspaceScopedJsonStorage<T>(): PersistStorage<T> {
  return {
    getItem: (name): StorageValue<T> | null => {
      if (typeof window === "undefined" || !window.localStorage) {
        return null;
      }
      const raw = window.localStorage.getItem(workspaceScopedStorageKey(name));
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as StorageValue<T>;
    },
    setItem: (name, value): void => {
      if (typeof window === "undefined" || !window.localStorage) {
        return;
      }
      window.localStorage.setItem(workspaceScopedStorageKey(name), JSON.stringify(value));
    },
    removeItem: (name): void => {
      if (typeof window === "undefined" || !window.localStorage) {
        return;
      }
      window.localStorage.removeItem(workspaceScopedStorageKey(name));
    },
  };
}
