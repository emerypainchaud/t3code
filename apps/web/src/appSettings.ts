import { useCallback, useSyncExternalStore } from "react";
import { Option, Schema } from "effect";
import { type ProviderKind } from "@t3tools/contracts";
import { getDefaultModel, getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";

const APP_SETTINGS_STORAGE_KEY = "t3code:app-settings:v1";
const MAX_CUSTOM_MODEL_COUNT = 32;
export const MAX_CUSTOM_MODEL_LENGTH = 256;
export const TIMESTAMP_FORMAT_OPTIONS = ["locale", "12-hour", "24-hour"] as const;
export type TimestampFormat = (typeof TIMESTAMP_FORMAT_OPTIONS)[number];
export const DEFAULT_TIMESTAMP_FORMAT: TimestampFormat = "locale";
export const LOCAL_WORKSPACE_ID = "local";
const MAX_WORKSPACE_COUNT = 24;
const MAX_WORKSPACE_FIELD_LENGTH = 4096;
export const APP_SERVICE_TIER_OPTIONS = [
  {
    value: "auto",
    label: "Automatic",
    description: "Use Codex defaults without forcing a service tier.",
  },
  {
    value: "fast",
    label: "Fast",
    description: "Request the fast service tier when the model supports it.",
  },
  {
    value: "flex",
    label: "Flex",
    description: "Request the flex service tier when the model supports it.",
  },
] as const;
export type AppServiceTier = (typeof APP_SERVICE_TIER_OPTIONS)[number]["value"];
const AppServiceTierSchema = Schema.Literals(["auto", "fast", "flex"]);
const WorkspaceFieldSchema = Schema.String.check(Schema.isMaxLength(MAX_WORKSPACE_FIELD_LENGTH));
const WorkspaceIdSchema = Schema.String.check(Schema.isMaxLength(128));
const MODELS_WITH_FAST_SUPPORT = new Set(["gpt-5.4"]);
const BUILT_IN_MODEL_SLUGS_BY_PROVIDER: Record<ProviderKind, ReadonlySet<string>> = {
  codex: new Set(getModelOptions("codex").map((option) => option.slug)),
  claudeCode: new Set(getModelOptions("claudeCode").map((option) => option.slug)),
};

const SavedWorkspaceDeploymentSchema = Schema.Struct({
  host: WorkspaceFieldSchema,
  username: Schema.optional(WorkspaceFieldSchema),
  port: Schema.optional(Schema.Number),
  connectHost: Schema.optional(WorkspaceFieldSchema),
  serverPort: Schema.optional(Schema.Number),
  serviceName: Schema.optional(WorkspaceFieldSchema),
  deployedVersion: Schema.optional(WorkspaceFieldSchema),
});
export type SavedWorkspaceDeployment = typeof SavedWorkspaceDeploymentSchema.Type;

const SavedWorkspaceSshSchema = Schema.Struct({
  host: WorkspaceFieldSchema,
  username: Schema.optional(WorkspaceFieldSchema),
  port: Schema.optional(Schema.Number),
});
export type SavedWorkspaceSsh = typeof SavedWorkspaceSshSchema.Type;

const SavedWorkspaceSchema = Schema.Struct({
  id: WorkspaceIdSchema,
  name: WorkspaceFieldSchema,
  wsUrl: WorkspaceFieldSchema,
  authToken: WorkspaceFieldSchema,
  deployment: Schema.optional(SavedWorkspaceDeploymentSchema),
  ssh: Schema.optional(SavedWorkspaceSshSchema),
});
type SavedWorkspace = typeof SavedWorkspaceSchema.Type;

const AppSettingsSchema = Schema.Struct({
  codexBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withDecodingDefault(() => ""),
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  claudeBinaryPath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withDecodingDefault(() => ""),
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  codexHomePath: Schema.String.check(Schema.isMaxLength(4096)).pipe(
    Schema.withDecodingDefault(() => ""),
    Schema.withConstructorDefault(() => Option.some("")),
  ),
  defaultThreadEnvMode: Schema.Literals(["local", "worktree"]).pipe(
    Schema.withDecodingDefault(() => "local"),
    Schema.withConstructorDefault(() => Option.some("local" as const)),
  ),
  confirmThreadDelete: Schema.Boolean.pipe(
    Schema.withDecodingDefault(() => true),
    Schema.withConstructorDefault(() => Option.some(true)),
  ),
  enableAssistantStreaming: Schema.Boolean.pipe(
    Schema.withDecodingDefault(() => false),
    Schema.withConstructorDefault(() => Option.some(false)),
  ),
  timestampFormat: Schema.Literals(["locale", "12-hour", "24-hour"]).pipe(
    Schema.withDecodingDefault(() => DEFAULT_TIMESTAMP_FORMAT),
    Schema.withConstructorDefault(() => Option.some(DEFAULT_TIMESTAMP_FORMAT)),
  ),
  codexServiceTier: AppServiceTierSchema.pipe(
    Schema.withDecodingDefault(() => "auto"),
    Schema.withConstructorDefault(() => Option.some("auto" as const)),
  ),
  customCodexModels: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(() => []),
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  customClaudeCodeModels: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(() => []),
    Schema.withConstructorDefault(() => Option.some([])),
  ),
  activeWorkspaceId: WorkspaceIdSchema.pipe(
    Schema.withDecodingDefault(() => LOCAL_WORKSPACE_ID),
    Schema.withConstructorDefault(() => Option.some(LOCAL_WORKSPACE_ID)),
  ),
  workspaces: Schema.Array(SavedWorkspaceSchema).pipe(
    Schema.withDecodingDefault(() => []),
    Schema.withConstructorDefault(() => Option.some([])),
  ),
});
export type AppSettings = typeof AppSettingsSchema.Type;
export interface AppModelOption {
  slug: string;
  name: string;
  isCustom: boolean;
}
export interface AppWorkspace {
  id: string;
  name: string;
  wsUrl: string;
  authToken: string;
  isLocal: boolean;
  deployment: SavedWorkspaceDeployment | null;
  ssh: SavedWorkspaceSsh | null;
}

function normalizeWorkspaceName(input: string, normalizedUrl: string): string {
  const trimmed = input.trim();
  if (trimmed.length > 0) {
    return trimmed;
  }
  try {
    return new URL(normalizedUrl).host;
  } catch {
    return "Workspace";
  }
}

export function normalizeWorkspaceUrl(input: string | null | undefined): string | null {
  const trimmed = input?.trim() ?? "";
  if (trimmed.length === 0 || trimmed.length > MAX_WORKSPACE_FIELD_LENGTH) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol === "http:") {
    url.protocol = "ws:";
  } else if (url.protocol === "https:") {
    url.protocol = "wss:";
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return null;
  }

  url.hash = "";
  if (url.pathname === "/" && url.search.length === 0) {
    return url.origin.replace(/\/$/, "");
  }
  return url.toString();
}

function normalizeSavedWorkspaces(workspaces: readonly SavedWorkspace[]): SavedWorkspace[] {
  const normalized: SavedWorkspace[] = [];
  const seenIds = new Set<string>();

  for (const workspace of workspaces) {
    const id = workspace.id.trim();
    const wsUrl = normalizeWorkspaceUrl(workspace.wsUrl);
    if (id.length === 0 || id === LOCAL_WORKSPACE_ID || seenIds.has(id) || wsUrl === null) {
      continue;
    }

    seenIds.add(id);
    const deploymentHost = workspace.deployment?.host?.trim() ?? "";
    const sshHost = workspace.ssh?.host?.trim() ?? "";
    normalized.push({
      id,
      name: normalizeWorkspaceName(workspace.name, wsUrl),
      wsUrl,
      authToken: workspace.authToken.trim(),
      ...(deploymentHost
        ? {
            deployment: {
              host: deploymentHost,
              ...(workspace.deployment?.username?.trim()
                ? { username: workspace.deployment.username.trim() }
                : {}),
              ...(typeof workspace.deployment?.port === "number" &&
              Number.isInteger(workspace.deployment.port) &&
              workspace.deployment.port > 0 &&
              workspace.deployment.port <= 65535
                ? { port: workspace.deployment.port }
                : {}),
              ...(workspace.deployment?.connectHost?.trim()
                ? { connectHost: workspace.deployment.connectHost.trim() }
                : {}),
              ...(typeof workspace.deployment?.serverPort === "number" &&
              Number.isInteger(workspace.deployment.serverPort) &&
              workspace.deployment.serverPort > 0 &&
              workspace.deployment.serverPort <= 65535
                ? { serverPort: workspace.deployment.serverPort }
                : {}),
              ...(workspace.deployment?.serviceName?.trim()
                ? { serviceName: workspace.deployment.serviceName.trim() }
                : {}),
              ...(workspace.deployment?.deployedVersion?.trim()
                ? { deployedVersion: workspace.deployment.deployedVersion.trim() }
                : {}),
            },
          }
        : {}),
      ...(sshHost
        ? {
            ssh: {
              host: sshHost,
              ...(workspace.ssh?.username?.trim()
                ? { username: workspace.ssh.username.trim() }
                : {}),
              ...(typeof workspace.ssh?.port === "number" &&
              Number.isInteger(workspace.ssh.port) &&
              workspace.ssh.port > 0 &&
              workspace.ssh.port <= 65535
                ? { port: workspace.ssh.port }
                : {}),
            },
          }
        : {}),
    });

    if (normalized.length >= MAX_WORKSPACE_COUNT) {
      break;
    }
  }

  return normalized;
}

export function getAppWorkspaces(settings: AppSettings): AppWorkspace[] {
  return [
    {
      id: LOCAL_WORKSPACE_ID,
      name: "This server",
      wsUrl: "",
      authToken: "",
      isLocal: true,
      deployment: null,
      ssh: null,
    },
    ...normalizeSavedWorkspaces(settings.workspaces).map((workspace) => ({
      id: workspace.id,
      name: workspace.name,
      wsUrl: workspace.wsUrl,
      authToken: workspace.authToken,
      isLocal: false as const,
      deployment: workspace.deployment ?? null,
      ssh: workspace.ssh ?? null,
    })),
  ];
}

export function resolveActiveWorkspace(settings: AppSettings): AppWorkspace {
  const workspaces = getAppWorkspaces(settings);
  return (
    workspaces.find((workspace) => workspace.id === settings.activeWorkspaceId) ??
    workspaces[0] ?? {
      id: LOCAL_WORKSPACE_ID,
      name: "This server",
      wsUrl: "",
      authToken: "",
      isLocal: true,
      deployment: null,
      ssh: null,
    }
  );
}

export interface WorkspaceSshConnection {
  host: string;
  username?: string;
  port?: number;
}

export function resolveWorkspaceSshConnection(
  workspace: Pick<AppWorkspace, "isLocal" | "wsUrl" | "deployment" | "ssh">,
): WorkspaceSshConnection | null {
  if (workspace.isLocal) {
    return null;
  }

  if (workspace.deployment?.host?.trim()) {
    return {
      host: workspace.deployment.host.trim(),
      ...(workspace.deployment.username?.trim()
        ? { username: workspace.deployment.username.trim() }
        : {}),
      ...(workspace.deployment.port !== undefined ? { port: workspace.deployment.port } : {}),
    };
  }

  if (workspace.ssh?.host?.trim()) {
    return {
      host: workspace.ssh.host.trim(),
      ...(workspace.ssh.username?.trim() ? { username: workspace.ssh.username.trim() } : {}),
      ...(workspace.ssh.port !== undefined ? { port: workspace.ssh.port } : {}),
    };
  }

  try {
    const url = new URL(workspace.wsUrl);
    return url.hostname.trim().length > 0 ? { host: url.hostname.trim() } : null;
  } catch {
    return null;
  }
}

export function resolveAppServiceTier(serviceTier: AppServiceTier): "fast" | "flex" | null {
  return serviceTier === "auto" ? null : serviceTier;
}

export function shouldShowFastTierIcon(
  model: string | null | undefined,
  serviceTier: AppServiceTier,
): boolean {
  const normalizedModel = normalizeModelSlug(model);
  return (
    resolveAppServiceTier(serviceTier) === "fast" &&
    normalizedModel !== null &&
    MODELS_WITH_FAST_SUPPORT.has(normalizedModel)
  );
}

const DEFAULT_APP_SETTINGS = AppSettingsSchema.makeUnsafe({});

let listeners: Array<() => void> = [];
let cachedRawSettings: string | null | undefined;
let cachedSnapshot: AppSettings = DEFAULT_APP_SETTINGS;

function getDesktopPersistedSettingsRaw(): string | null | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  return window.desktopBridge?.getPersistedAppSettings?.();
}

function getLocalStoragePersistedSettingsRaw(): string | null {
  if (typeof window === "undefined" || !("localStorage" in window) || !window.localStorage) {
    return null;
  }
  return window.localStorage.getItem(APP_SETTINGS_STORAGE_KEY);
}

export function normalizeCustomModelSlugs(
  models: Iterable<string | null | undefined>,
  provider: ProviderKind = "codex",
): string[] {
  const normalizedModels: string[] = [];
  const seen = new Set<string>();
  const builtInModelSlugs = BUILT_IN_MODEL_SLUGS_BY_PROVIDER[provider];

  for (const candidate of models) {
    const normalized = normalizeModelSlug(candidate, provider);
    if (
      !normalized ||
      normalized.length > MAX_CUSTOM_MODEL_LENGTH ||
      builtInModelSlugs.has(normalized) ||
      seen.has(normalized)
    ) {
      continue;
    }

    seen.add(normalized);
    normalizedModels.push(normalized);
    if (normalizedModels.length >= MAX_CUSTOM_MODEL_COUNT) {
      break;
    }
  }

  return normalizedModels;
}

function normalizeAppSettings(settings: AppSettings): AppSettings {
  const workspaces = normalizeSavedWorkspaces(settings.workspaces);
  const activeWorkspaceId =
    settings.activeWorkspaceId === LOCAL_WORKSPACE_ID ||
    workspaces.some((workspace) => workspace.id === settings.activeWorkspaceId)
      ? settings.activeWorkspaceId
      : LOCAL_WORKSPACE_ID;
  return {
    ...settings,
    customCodexModels: normalizeCustomModelSlugs(settings.customCodexModels, "codex"),
    customClaudeCodeModels: normalizeCustomModelSlugs(
      settings.customClaudeCodeModels,
      "claudeCode",
    ),
    workspaces,
    activeWorkspaceId,
  };
}

export function getAppModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel?: string | null,
): AppModelOption[] {
  const options: AppModelOption[] = getModelOptions(provider).map(({ slug, name }) => ({
    slug,
    name,
    isCustom: false,
  }));
  const seen = new Set(options.map((option) => option.slug));

  for (const slug of normalizeCustomModelSlugs(customModels, provider)) {
    if (seen.has(slug)) {
      continue;
    }

    seen.add(slug);
    options.push({
      slug,
      name: slug,
      isCustom: true,
    });
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (normalizedSelectedModel && !seen.has(normalizedSelectedModel)) {
    options.push({
      slug: normalizedSelectedModel,
      name: normalizedSelectedModel,
      isCustom: true,
    });
  }

  return options;
}

export function resolveAppModelSelection(
  provider: ProviderKind,
  customModels: readonly string[],
  selectedModel: string | null | undefined,
): string {
  const options = getAppModelOptions(provider, customModels, selectedModel);
  const trimmedSelectedModel = selectedModel?.trim();
  if (trimmedSelectedModel) {
    const direct = options.find((option) => option.slug === trimmedSelectedModel);
    if (direct) {
      return direct.slug;
    }

    const byName = options.find(
      (option) => option.name.toLowerCase() === trimmedSelectedModel.toLowerCase(),
    );
    if (byName) {
      return byName.slug;
    }
  }

  const normalizedSelectedModel = normalizeModelSlug(selectedModel, provider);
  if (!normalizedSelectedModel) {
    return getDefaultModel(provider);
  }

  return (
    options.find((option) => option.slug === normalizedSelectedModel)?.slug ??
    getDefaultModel(provider)
  );
}

export function getSlashModelOptions(
  provider: ProviderKind,
  customModels: readonly string[],
  query: string,
  selectedModel?: string | null,
): AppModelOption[] {
  const normalizedQuery = query.trim().toLowerCase();
  const options = getAppModelOptions(provider, customModels, selectedModel);
  if (!normalizedQuery) {
    return options;
  }

  return options.filter((option) => {
    const searchSlug = option.slug.toLowerCase();
    const searchName = option.name.toLowerCase();
    return searchSlug.includes(normalizedQuery) || searchName.includes(normalizedQuery);
  });
}

function emitChange(): void {
  for (const listener of listeners) {
    listener();
  }
}

function parsePersistedSettings(value: string | null): AppSettings {
  if (!value) {
    return DEFAULT_APP_SETTINGS;
  }

  try {
    return normalizeAppSettings(Schema.decodeSync(Schema.fromJsonString(AppSettingsSchema))(value));
  } catch {
    return DEFAULT_APP_SETTINGS;
  }
}

export function getAppSettingsSnapshot(): AppSettings {
  if (typeof window === "undefined") {
    return DEFAULT_APP_SETTINGS;
  }

  const desktopRaw = getDesktopPersistedSettingsRaw();
  const raw =
    desktopRaw ??
    (() => {
      const localStorageRaw = getLocalStoragePersistedSettingsRaw();
      if (desktopRaw === null && localStorageRaw && window.desktopBridge?.setPersistedAppSettings) {
        void window.desktopBridge.setPersistedAppSettings(localStorageRaw);
      }
      return localStorageRaw;
    })();
  if (raw === cachedRawSettings) {
    return cachedSnapshot;
  }

  cachedRawSettings = raw;
  cachedSnapshot = parsePersistedSettings(raw);
  return cachedSnapshot;
}

function persistSettings(next: AppSettings): void {
  if (typeof window === "undefined") return;

  const raw = JSON.stringify(next);
  try {
    if (window.desktopBridge?.setPersistedAppSettings) {
      if (raw !== cachedRawSettings) {
        void window.desktopBridge.setPersistedAppSettings(raw);
      }
    } else if ("localStorage" in window && window.localStorage && raw !== cachedRawSettings) {
      window.localStorage.setItem(APP_SETTINGS_STORAGE_KEY, raw);
    }
  } catch {
    // Best-effort persistence only.
  }

  cachedRawSettings = raw;
  cachedSnapshot = next;
}

function subscribe(listener: () => void): () => void {
  listeners.push(listener);

  if (typeof window === "undefined") {
    return () => {
      listeners = listeners.filter((entry) => entry !== listener);
    };
  }

  const bridgeUnsubscribe = window.desktopBridge?.onPersistedAppSettings?.((raw) => {
    if (raw === cachedRawSettings) {
      return;
    }
    cachedRawSettings = raw;
    cachedSnapshot = parsePersistedSettings(raw);
    emitChange();
  });

  if (typeof window.addEventListener !== "function") {
    return () => {
      listeners = listeners.filter((entry) => entry !== listener);
      bridgeUnsubscribe?.();
    };
  }

  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_SETTINGS_STORAGE_KEY && !window.desktopBridge?.getPersistedAppSettings) {
      emitChange();
    }
  };

  window.addEventListener("storage", onStorage);
  return () => {
    listeners = listeners.filter((entry) => entry !== listener);
    bridgeUnsubscribe?.();
    window.removeEventListener("storage", onStorage);
  };
}

export const subscribeAppSettings = subscribe;

export function useAppSettings() {
  const settings = useSyncExternalStore(
    subscribe,
    getAppSettingsSnapshot,
    () => DEFAULT_APP_SETTINGS,
  );

  const updateSettings = useCallback((patch: Partial<AppSettings>) => {
    const next = normalizeAppSettings(
      Schema.decodeSync(AppSettingsSchema)({
        ...getAppSettingsSnapshot(),
        ...patch,
      }),
    );
    persistSettings(next);
    emitChange();
  }, []);

  const resetSettings = useCallback(() => {
    persistSettings(DEFAULT_APP_SETTINGS);
    emitChange();
  }, []);

  return {
    settings,
    activeWorkspace: resolveActiveWorkspace(settings),
    workspaces: getAppWorkspaces(settings),
    updateSettings,
    resetSettings,
    defaults: DEFAULT_APP_SETTINGS,
  } as const;
}
