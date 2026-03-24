import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useState } from "react";
import {
  type DesktopDeployRemoteWorkspaceResult,
  type DesktopUpdateState,
  type DesktopRemoteTlsCertificateInspection,
  type ProviderKind,
} from "@t3tools/contracts";
import { getModelOptions, normalizeModelSlug } from "@t3tools/shared/model";
import {
  CheckIcon,
  CopyIcon,
  GlobeIcon,
  KeyRoundIcon,
  PlusIcon,
  RefreshCcwIcon,
  ServerCogIcon,
  Trash2Icon,
  ZapIcon,
} from "lucide-react";

import {
  APP_SERVICE_TIER_OPTIONS,
  LOCAL_WORKSPACE_ID,
  MAX_CUSTOM_MODEL_LENGTH,
  normalizeWorkspaceUrl,
  resolveWorkspaceSshConnection,
  shouldShowFastTierIcon,
  useAppSettings,
} from "../appSettings";
import { openInPreferredEditor } from "../editorPreferences";
import { isElectron } from "../env";
import { useTheme } from "../hooks/useTheme";
import { serverConfigQueryOptions, serverQueryKeys } from "../lib/serverReactQuery";
import { ensureNativeApi } from "../nativeApi";
import { validateWorkspaceTlsInspection } from "../workspaceTls";
import { useWorkspaceConnectionState } from "../workspaceConnectionState";
import {
  workspaceStatusDotClassName,
  workspaceStatusLabel,
  workspaceStatusTextClassName,
} from "../workspaceStatus";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { SidebarInset } from "~/components/ui/sidebar";
import { useStore } from "../store";
import { ProjectExecutionSettingsSection } from "../components/ProjectExecutionSettingsSection";

const THEME_OPTIONS = [
  {
    value: "system",
    label: "System",
    description: "Match your OS appearance setting.",
  },
  {
    value: "light",
    label: "Light",
    description: "Always use the light theme.",
  },
  {
    value: "dark",
    label: "Dark",
    description: "Always use the dark theme.",
  },
] as const;

const MODEL_PROVIDER_SETTINGS: Array<{
  provider: ProviderKind;
  title: string;
  description: string;
  placeholder: string;
  example: string;
}> = [
  {
    provider: "codex",
    title: "Codex",
    description: "Save additional Codex model slugs for the picker and `/model` command.",
    placeholder: "your-codex-model-slug",
    example: "gpt-6.7-codex-ultra-preview",
  },
  {
    provider: "claudeCode",
    title: "Claude Code",
    description: "Save additional Claude Code model slugs for the picker and `/model` command.",
    placeholder: "your-claude-model-slug",
    example: "claude-sonnet-5-0-preview",
  },
] as const;

function getCustomModelsForProvider(
  settings: ReturnType<typeof useAppSettings>["settings"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
    default:
      return settings.customCodexModels;
    case "claudeCode":
      return settings.customClaudeCodeModels;
  }
}

function getDefaultCustomModelsForProvider(
  defaults: ReturnType<typeof useAppSettings>["defaults"],
  provider: ProviderKind,
) {
  switch (provider) {
    case "codex":
    default:
      return defaults.customCodexModels;
    case "claudeCode":
      return defaults.customClaudeCodeModels;
  }
}

function patchCustomModels(provider: ProviderKind, models: string[]) {
  switch (provider) {
    case "codex":
    default:
      return { customCodexModels: models };
    case "claudeCode":
      return { customClaudeCodeModels: models };
  }
}

async function copyTextToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

function isWorkspaceCertificateReady(
  certificate: DesktopRemoteTlsCertificateInspection | null,
  normalizedUrl: string | null,
): boolean {
  if (!certificate || !normalizedUrl || certificate.url !== normalizedUrl) {
    return false;
  }
  return certificate.trusted || certificate.verificationError === null;
}

function SettingsRouteView() {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const { settings, defaults, updateSettings, activeWorkspace, workspaces } = useAppSettings();
  const projects = useStore((state) => state.projects);
  const activeWorkspaceConnectionState = useWorkspaceConnectionState(activeWorkspace.id);
  const serverConfigQuery = useQuery(serverConfigQueryOptions());
  const queryClient = useQueryClient();
  const [isOpeningKeybindings, setIsOpeningKeybindings] = useState(false);
  const [openKeybindingsError, setOpenKeybindingsError] = useState<string | null>(null);
  const [workspaceNameInput, setWorkspaceNameInput] = useState("");
  const [workspaceUrlInput, setWorkspaceUrlInput] = useState("");
  const [workspaceTokenInput, setWorkspaceTokenInput] = useState("");
  const [workspaceSshHostInput, setWorkspaceSshHostInput] = useState("");
  const [workspaceSshUsernameInput, setWorkspaceSshUsernameInput] = useState("");
  const [workspaceSshPortInput, setWorkspaceSshPortInput] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [workspaceCertificate, setWorkspaceCertificate] =
    useState<DesktopRemoteTlsCertificateInspection | null>(null);
  const [workspaceCertificateMessage, setWorkspaceCertificateMessage] = useState<string | null>(
    null,
  );
  const [workspaceAccessMessage, setWorkspaceAccessMessage] = useState<string | null>(null);
  const [deployWorkspaceHostInput, setDeployWorkspaceHostInput] = useState("");
  const [deployWorkspaceUsernameInput, setDeployWorkspaceUsernameInput] = useState("");
  const [deployWorkspaceSshPortInput, setDeployWorkspaceSshPortInput] = useState("");
  const [deployWorkspaceConnectHostInput, setDeployWorkspaceConnectHostInput] = useState("");
  const [deployWorkspaceServerPortInput, setDeployWorkspaceServerPortInput] = useState("");
  const [deployWorkspaceNameInput, setDeployWorkspaceNameInput] = useState("");
  const [deployWorkspaceMessage, setDeployWorkspaceMessage] = useState<string | null>(null);
  const [desktopUpdateState, setDesktopUpdateState] = useState<DesktopUpdateState | null>(null);
  const [customModelInputByProvider, setCustomModelInputByProvider] = useState<
    Record<ProviderKind, string>
  >({
    codex: "",
    claudeCode: "",
  });
  const [customModelErrorByProvider, setCustomModelErrorByProvider] = useState<
    Partial<Record<ProviderKind, string | null>>
  >({});

  const codexBinaryPath = settings.codexBinaryPath;
  const claudeBinaryPath = settings.claudeBinaryPath;
  const codexHomePath = settings.codexHomePath;
  const codexServiceTier = settings.codexServiceTier;
  const keybindingsConfigPath = serverConfigQuery.data?.keybindingsConfigPath ?? null;
  const workspaceAccess = serverConfigQuery.data?.workspaceAccess ?? null;
  const normalizedWorkspaceUrl = normalizeWorkspaceUrl(workspaceUrlInput);
  const workspaceRequiresTlsTrust =
    isElectron && normalizedWorkspaceUrl !== null && normalizedWorkspaceUrl.startsWith("wss://");
  const workspaceCertificateReady = isWorkspaceCertificateReady(
    workspaceCertificate,
    normalizedWorkspaceUrl,
  );
  const desktopCurrentVersion =
    desktopUpdateState?.currentVersion?.trim() &&
    desktopUpdateState.currentVersion.trim().length > 0
      ? desktopUpdateState.currentVersion.trim()
      : null;

  useEffect(() => {
    if (!isElectron) return;
    const bridge = window.desktopBridge;
    if (
      !bridge ||
      typeof bridge.getUpdateState !== "function" ||
      typeof bridge.onUpdateState !== "function"
    ) {
      return;
    }

    let disposed = false;
    let receivedSubscriptionUpdate = false;
    const unsubscribe = bridge.onUpdateState((nextState) => {
      if (disposed) return;
      receivedSubscriptionUpdate = true;
      setDesktopUpdateState(nextState);
    });

    void bridge
      .getUpdateState()
      .then((nextState) => {
        if (disposed || receivedSubscriptionUpdate) return;
        setDesktopUpdateState(nextState);
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, []);

  const rotateWorkspaceAccessMutation = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.server.rotateWorkspaceAccessToken();
    },
    onSuccess: async () => {
      setWorkspaceAccessMessage("Workspace key rotated.");
      await queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    },
    onError: (error) => {
      setWorkspaceAccessMessage(
        error instanceof Error ? error.message : "Unable to rotate workspace key.",
      );
    },
  });

  const rotateWorkspaceTlsCertificateMutation = useMutation({
    mutationFn: async () => {
      const api = ensureNativeApi();
      return api.server.rotateWorkspaceTlsCertificate();
    },
    onSuccess: async () => {
      setWorkspaceAccessMessage("Workspace certificate rotated.");
      setWorkspaceCertificate(null);
      setWorkspaceCertificateMessage(null);
      await queryClient.invalidateQueries({ queryKey: serverQueryKeys.config() });
    },
    onError: (error) => {
      setWorkspaceAccessMessage(
        error instanceof Error ? error.message : "Unable to rotate workspace certificate.",
      );
    },
  });

  const inspectWorkspaceCertificateMutation = useMutation({
    mutationFn: async (url: string) => {
      const api = ensureNativeApi();
      return api.server.inspectRemoteTlsCertificate(url);
    },
    onSuccess: (inspection) => {
      setWorkspaceCertificate(inspection);
      setWorkspaceCertificateMessage(
        inspection.trusted
          ? "Certificate already trusted on this device."
          : inspection.verificationError === null
            ? "Certificate is already trusted by the system."
            : inspection.selfSigned
              ? "Review the self-signed certificate fingerprint, then trust it on this device."
              : `TLS verification failed: ${inspection.verificationError}`,
      );
    },
    onError: (error) => {
      setWorkspaceCertificate(null);
      setWorkspaceCertificateMessage(
        error instanceof Error ? error.message : "Unable to inspect the remote certificate.",
      );
    },
  });

  const trustWorkspaceCertificateMutation = useMutation({
    mutationFn: async (input: { url: string; fingerprintSha256: string }) => {
      const api = ensureNativeApi();
      await api.server.trustRemoteTlsCertificate(input);
    },
    onSuccess: () => {
      setWorkspaceCertificate((existing) => (existing ? { ...existing, trusted: true } : existing));
      setWorkspaceCertificateMessage("Certificate fingerprint trusted on this device.");
    },
    onError: (error) => {
      setWorkspaceCertificateMessage(
        error instanceof Error ? error.message : "Unable to trust the remote certificate.",
      );
    },
  });

  const inspectWorkspaceCertificate = useCallback(async () => {
    if (!normalizedWorkspaceUrl || !normalizedWorkspaceUrl.startsWith("wss://")) {
      setWorkspaceCertificate(null);
      setWorkspaceCertificateMessage(null);
      return null;
    }

    setWorkspaceError(null);
    return inspectWorkspaceCertificateMutation.mutateAsync(normalizedWorkspaceUrl);
  }, [inspectWorkspaceCertificateMutation, normalizedWorkspaceUrl]);

  const saveWorkspace = useCallback(
    async (input: {
      name: string;
      normalizedUrl: string;
      authToken: string;
      knownTlsFingerprintSha256?: string | null;
      sshHost?: string;
      sshUsername?: string;
      sshPort?: number;
    }) => {
      if (
        settings.workspaces.some(
          (workspace) =>
            workspace.wsUrl === input.normalizedUrl ||
            workspace.name.toLowerCase() === input.name.toLowerCase(),
        )
      ) {
        setWorkspaceError("That workspace is already saved.");
        return false;
      }

      if (
        isElectron &&
        input.knownTlsFingerprintSha256 &&
        input.normalizedUrl.startsWith("wss://")
      ) {
        try {
          const api = ensureNativeApi();
          const inspection = await api.server.inspectRemoteTlsCertificate(input.normalizedUrl);
          const validation = validateWorkspaceTlsInspection({
            inspection,
            expectedFingerprintSha256: input.knownTlsFingerprintSha256,
          });
          if (!validation.ok) {
            setWorkspaceError(validation.error);
            return false;
          }

          if (validation.shouldTrust) {
            await api.server.trustRemoteTlsCertificate({
              url: input.normalizedUrl,
              fingerprintSha256: inspection.fingerprintSha256,
            });
          }
        } catch (error) {
          setWorkspaceError(
            error instanceof Error ? error.message : "Unable to verify the remote certificate.",
          );
          return false;
        }
      }

      updateSettings({
        workspaces: [
          ...settings.workspaces,
          {
            id: crypto.randomUUID(),
            name: input.name,
            wsUrl: input.normalizedUrl,
            authToken: input.authToken.trim(),
            ...(input.sshHost
              ? {
                  ssh: {
                    host: input.sshHost,
                    ...(input.sshUsername ? { username: input.sshUsername } : {}),
                    ...(input.sshPort !== undefined ? { port: input.sshPort } : {}),
                  },
                }
              : {}),
          },
        ],
      });
      setWorkspaceError(null);
      return true;
    },
    [settings.workspaces, updateSettings],
  );

  const saveOrUpdateDeployedWorkspace = useCallback(
    (
      input: DesktopDeployRemoteWorkspaceResult,
      deploymentRequest: {
        host: string;
        username?: string;
        port?: number;
        connectHost?: string;
        serverPort?: number;
      },
    ) => {
      const existingWorkspace = settings.workspaces.find(
        (workspace) => workspace.wsUrl === input.wsUrl,
      );
      const nextDeployment = {
        host: deploymentRequest.host,
        ...(deploymentRequest.username ? { username: deploymentRequest.username } : {}),
        ...(deploymentRequest.port !== undefined ? { port: deploymentRequest.port } : {}),
        ...(deploymentRequest.connectHost ? { connectHost: deploymentRequest.connectHost } : {}),
        ...(deploymentRequest.serverPort !== undefined
          ? { serverPort: deploymentRequest.serverPort }
          : {}),
        serviceName: input.serviceName,
        ...(input.deployedVersion ? { deployedVersion: input.deployedVersion } : {}),
      };

      if (existingWorkspace) {
        updateSettings({
          activeWorkspaceId: existingWorkspace.id,
          workspaces: settings.workspaces.map((workspace) =>
            workspace.id === existingWorkspace.id
              ? {
                  ...workspace,
                  name: input.workspaceName,
                  authToken: input.authToken,
                  deployment: nextDeployment,
                }
              : workspace,
          ),
        });
        return "updated" as const;
      }

      if (
        settings.workspaces.some(
          (workspace) => workspace.name.toLowerCase() === input.workspaceName.toLowerCase(),
        )
      ) {
        throw new Error(
          `A workspace named "${input.workspaceName}" already exists. Rename it or choose a different label before deploying.`,
        );
      }

      const workspaceId = crypto.randomUUID();
      updateSettings({
        activeWorkspaceId: workspaceId,
        workspaces: [
          ...settings.workspaces,
          {
            id: workspaceId,
            name: input.workspaceName,
            wsUrl: input.wsUrl,
            authToken: input.authToken,
            deployment: nextDeployment,
          },
        ],
      });
      return "created" as const;
    },
    [settings.workspaces, updateSettings],
  );

  const deployWorkspaceMutation = useMutation({
    mutationFn: async () => {
      const host = deployWorkspaceHostInput.trim();
      if (!host) {
        throw new Error("SSH host is required.");
      }

      const parsedSshPort = deployWorkspaceSshPortInput.trim();
      const sshPort = parsedSshPort.length > 0 ? Number.parseInt(parsedSshPort, 10) : null;
      if (sshPort !== null && (!Number.isInteger(sshPort) || sshPort <= 0 || sshPort > 65535)) {
        throw new Error("SSH port must be between 1 and 65535.");
      }

      const parsedServerPort = deployWorkspaceServerPortInput.trim();
      const serverPort = parsedServerPort.length > 0 ? Number.parseInt(parsedServerPort, 10) : null;
      if (
        serverPort !== null &&
        (!Number.isInteger(serverPort) || serverPort <= 0 || serverPort > 65535)
      ) {
        throw new Error("Server port must be between 1 and 65535.");
      }

      const api = ensureNativeApi();
      const deploymentInput = {
        host,
        ...(deployWorkspaceUsernameInput.trim()
          ? { username: deployWorkspaceUsernameInput.trim() }
          : {}),
        ...(sshPort !== null ? { port: sshPort } : {}),
        ...(deployWorkspaceConnectHostInput.trim()
          ? { connectHost: deployWorkspaceConnectHostInput.trim() }
          : {}),
        ...(serverPort !== null ? { serverPort } : {}),
        ...(deployWorkspaceNameInput.trim()
          ? { workspaceName: deployWorkspaceNameInput.trim() }
          : {}),
      };
      const deployment = await api.server.deployRemoteWorkspaceServer(deploymentInput);
      return { deployment, deploymentInput };
    },
    onSuccess: ({ deployment, deploymentInput }) => {
      try {
        const disposition = saveOrUpdateDeployedWorkspace(deployment, deploymentInput);
        setDeployWorkspaceNameInput("");
        setDeployWorkspaceHostInput("");
        setDeployWorkspaceUsernameInput("");
        setDeployWorkspaceSshPortInput("");
        setDeployWorkspaceConnectHostInput("");
        setDeployWorkspaceServerPortInput("");
        setWorkspaceNameInput("");
        setWorkspaceUrlInput("");
        setWorkspaceTokenInput("");
        setWorkspaceError(null);
        setWorkspaceCertificate(null);
        setWorkspaceCertificateMessage(null);
        const messageParts = [
          deployment.lingerEnabled === false
            ? `Remote workspace ${disposition === "created" ? "saved" : "updated"}. The service is running, but it may stop after logout until linger is enabled for that remote user.`
            : `Remote workspace ${disposition === "created" ? "saved" : "updated"} from ${deployment.serviceName}.`,
        ];
        if (deployment.deployedVersion) {
          messageParts.push(`Version ${deployment.deployedVersion}.`);
        }
        if (deployment.warnings.length > 0) {
          messageParts.push(deployment.warnings.join(" "));
        }
        setDeployWorkspaceMessage(messageParts.join(" "));
      } catch (error) {
        setDeployWorkspaceMessage(
          error instanceof Error
            ? error.message
            : "Remote workspace deployed, but it could not be saved locally.",
        );
      }
    },
    onError: (error) => {
      setDeployWorkspaceMessage(
        error instanceof Error ? error.message : "Unable to deploy the remote workspace server.",
      );
    },
  });

  const redeployManagedWorkspaceMutation = useMutation({
    mutationFn: async (workspaceId: string) => {
      const workspace = workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace || workspace.isLocal || !workspace.deployment) {
        throw new Error("This workspace is not managed by the desktop deployer.");
      }
      const api = ensureNativeApi();
      const deploymentInput = {
        host: workspace.deployment.host,
        ...(workspace.deployment.username ? { username: workspace.deployment.username } : {}),
        ...(workspace.deployment.port !== undefined ? { port: workspace.deployment.port } : {}),
        ...(workspace.deployment.connectHost
          ? { connectHost: workspace.deployment.connectHost }
          : {}),
        ...(workspace.deployment.serverPort !== undefined
          ? { serverPort: workspace.deployment.serverPort }
          : {}),
        workspaceName: workspace.name,
      };
      const deployment = await api.server.deployRemoteWorkspaceServer(deploymentInput);
      return { deployment, deploymentInput };
    },
    onSuccess: ({ deployment, deploymentInput }) => {
      try {
        saveOrUpdateDeployedWorkspace(deployment, deploymentInput);
        const messageParts = [`Remote workspace updated from ${deployment.serviceName}.`];
        if (deployment.deployedVersion) {
          messageParts.push(`Version ${deployment.deployedVersion}.`);
        }
        if (deployment.warnings.length > 0) {
          messageParts.push(deployment.warnings.join(" "));
        }
        setDeployWorkspaceMessage(messageParts.join(" "));
      } catch (error) {
        setDeployWorkspaceMessage(
          error instanceof Error
            ? error.message
            : "Remote workspace updated, but local settings could not be refreshed.",
        );
      }
    },
    onError: (error) => {
      setDeployWorkspaceMessage(
        error instanceof Error ? error.message : "Unable to update the remote workspace server.",
      );
    },
  });

  const addWorkspace = useCallback(async () => {
    const normalizedUrl = normalizedWorkspaceUrl;
    if (!normalizedUrl) {
      setWorkspaceError("Enter a valid ws://, wss://, http://, or https:// server URL.");
      return;
    }

    if (workspaceRequiresTlsTrust) {
      let certificate = workspaceCertificate;
      if (!workspaceCertificateReady) {
        try {
          certificate = await inspectWorkspaceCertificate();
        } catch {
          return;
        }
      }

      if (!isWorkspaceCertificateReady(certificate ?? null, normalizedUrl)) {
        setWorkspaceError(
          certificate?.selfSigned
            ? "Trust this self-signed certificate before adding the workspace."
            : certificate?.verificationError
              ? `TLS verification failed: ${certificate.verificationError}`
              : "Inspect the remote certificate before adding the workspace.",
        );
        return;
      }
    }

    const parsedSshPort = workspaceSshPortInput.trim();
    const sshPort = parsedSshPort.length > 0 ? Number.parseInt(parsedSshPort, 10) : null;
    if (sshPort !== null && (!Number.isInteger(sshPort) || sshPort <= 0 || sshPort > 65535)) {
      setWorkspaceError("SSH port must be between 1 and 65535.");
      return;
    }

    const normalizedName = workspaceNameInput.trim() || new URL(normalizedUrl).host;
    const didSave = await saveWorkspace({
      name: normalizedName,
      normalizedUrl,
      authToken: workspaceTokenInput.trim(),
      ...(workspaceSshHostInput.trim() ? { sshHost: workspaceSshHostInput.trim() } : {}),
      ...(workspaceSshUsernameInput.trim()
        ? { sshUsername: workspaceSshUsernameInput.trim() }
        : {}),
      ...(sshPort !== null ? { sshPort } : {}),
    });
    if (!didSave) {
      return;
    }

    setWorkspaceNameInput("");
    setWorkspaceUrlInput("");
    setWorkspaceTokenInput("");
    setWorkspaceSshHostInput("");
    setWorkspaceSshUsernameInput("");
    setWorkspaceSshPortInput("");
    setWorkspaceCertificate(null);
    setWorkspaceCertificateMessage(null);
  }, [
    inspectWorkspaceCertificate,
    normalizedWorkspaceUrl,
    saveWorkspace,
    workspaceCertificate,
    workspaceCertificateReady,
    workspaceNameInput,
    workspaceRequiresTlsTrust,
    workspaceSshHostInput,
    workspaceSshPortInput,
    workspaceSshUsernameInput,
    workspaceTokenInput,
  ]);

  const addWorkspaceFromInvitation = useCallback(
    async (input: { label: string; wsUrl: string }) => {
      if (!workspaceAccess) {
        return;
      }
      const normalizedUrl = normalizeWorkspaceUrl(input.wsUrl);
      if (!normalizedUrl) {
        setWorkspaceAccessMessage("Current server invitation has an invalid workspace URL.");
        return;
      }

      const didSave = await saveWorkspace({
        name: input.label.trim() || new URL(normalizedUrl).host,
        normalizedUrl,
        authToken: workspaceAccess.token,
        knownTlsFingerprintSha256: workspaceAccess.tls.fingerprintSha256 ?? null,
      });
      if (didSave) {
        setWorkspaceAccessMessage("Workspace saved.");
      }
    },
    [saveWorkspace, workspaceAccess],
  );

  const removeWorkspace = useCallback(
    (workspaceId: string) => {
      const nextWorkspaces = settings.workspaces.filter(
        (workspace) => workspace.id !== workspaceId,
      );
      updateSettings({
        workspaces: nextWorkspaces,
        activeWorkspaceId:
          settings.activeWorkspaceId === workspaceId
            ? LOCAL_WORKSPACE_ID
            : settings.activeWorkspaceId,
      });
    },
    [settings.activeWorkspaceId, settings.workspaces, updateSettings],
  );

  const setActiveWorkspace = useCallback(
    (workspaceId: string) => {
      updateSettings({ activeWorkspaceId: workspaceId });
    },
    [updateSettings],
  );

  const copyWorkspaceAccessValue = useCallback(async (value: string, label: string) => {
    try {
      await copyTextToClipboard(value);
      setWorkspaceAccessMessage(`${label} copied.`);
    } catch {
      setWorkspaceAccessMessage(`Unable to copy ${label.toLowerCase()}.`);
    }
  }, []);

  const openKeybindingsFile = useCallback(() => {
    if (!keybindingsConfigPath) return;
    setOpenKeybindingsError(null);
    setIsOpeningKeybindings(true);
    const api = ensureNativeApi();
    void openInPreferredEditor(api, keybindingsConfigPath, {
      workspace: activeWorkspace,
      targetKind: "file",
    })
      .catch((error) => {
        setOpenKeybindingsError(
          error instanceof Error ? error.message : "Unable to open keybindings file.",
        );
      })
      .finally(() => {
        setIsOpeningKeybindings(false);
      });
  }, [activeWorkspace, keybindingsConfigPath]);

  const addCustomModel = useCallback(
    (provider: ProviderKind) => {
      const customModelInput = customModelInputByProvider[provider];
      const customModels = getCustomModelsForProvider(settings, provider);
      const normalized = normalizeModelSlug(customModelInput, provider);
      if (!normalized) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "Enter a model slug.",
        }));
        return;
      }
      if (getModelOptions(provider).some((option) => option.slug === normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That model is already built in.",
        }));
        return;
      }
      if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.`,
        }));
        return;
      }
      if (customModels.includes(normalized)) {
        setCustomModelErrorByProvider((existing) => ({
          ...existing,
          [provider]: "That custom model is already saved.",
        }));
        return;
      }

      updateSettings(patchCustomModels(provider, [...customModels, normalized]));
      setCustomModelInputByProvider((existing) => ({
        ...existing,
        [provider]: "",
      }));
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [customModelInputByProvider, settings, updateSettings],
  );

  const removeCustomModel = useCallback(
    (provider: ProviderKind, slug: string) => {
      const customModels = getCustomModelsForProvider(settings, provider);
      updateSettings(
        patchCustomModels(
          provider,
          customModels.filter((model) => model !== slug),
        ),
      );
      setCustomModelErrorByProvider((existing) => ({
        ...existing,
        [provider]: null,
      }));
    },
    [settings, updateSettings],
  );

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        {isElectron && (
          <div className="drag-region flex h-[52px] shrink-0 items-center border-b border-border px-5">
            <span className="text-xs font-medium tracking-wide text-muted-foreground/70">
              Settings
            </span>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-6">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <header className="space-y-1">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">Settings</h1>
              <p className="text-sm text-muted-foreground">
                Configure app-level preferences for this device.
              </p>
            </header>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Workspaces</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save remote T3 servers and switch between them from the sidebar. Keys stay on this
                  device and are sent in the WebSocket handshake, not appended to the URL.
                </p>
              </div>

              <div className="space-y-3">
                {workspaces.map((workspace) => {
                  const isActive = workspace.id === activeWorkspace.id;
                  const statusLabel = isActive
                    ? workspaceStatusLabel(activeWorkspaceConnectionState)
                    : "Saved";
                  const statusClass = isActive
                    ? workspaceStatusTextClassName(activeWorkspaceConnectionState)
                    : "text-muted-foreground";
                  const statusDotClass = isActive
                    ? workspaceStatusDotClassName(activeWorkspaceConnectionState)
                    : "bg-zinc-400";
                  const managedDeployment = workspace.deployment;
                  const sshConnection = resolveWorkspaceSshConnection(workspace);
                  const managedWorkspaceVersion =
                    managedDeployment?.deployedVersion?.trim() || null;
                  const needsManagedUpdate =
                    !workspace.isLocal &&
                    managedDeployment !== null &&
                    desktopCurrentVersion !== null &&
                    managedWorkspaceVersion !== null &&
                    managedWorkspaceVersion !== desktopCurrentVersion;
                  const isUpdatingManagedWorkspace =
                    redeployManagedWorkspaceMutation.isPending &&
                    redeployManagedWorkspaceMutation.variables === workspace.id;
                  return (
                    <div
                      key={workspace.id}
                      className={`rounded-xl border px-4 py-3 ${
                        isActive
                          ? "border-primary/60 bg-primary/5"
                          : "border-border bg-background/40"
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 space-y-1">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-foreground">
                              {workspace.name}
                            </span>
                            {workspace.isLocal && (
                              <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Local
                              </span>
                            )}
                            {!workspace.isLocal && managedDeployment && (
                              <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                                Managed
                              </span>
                            )}
                            {isActive && (
                              <span className="rounded-full bg-primary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary-foreground">
                                Active
                              </span>
                            )}
                            {needsManagedUpdate && (
                              <span className="rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-700 dark:text-amber-300">
                                Update available
                              </span>
                            )}
                            <span
                              className={`ml-auto flex items-center gap-1 text-[11px] ${statusClass}`}
                            >
                              <span className={`size-1.5 rounded-full ${statusDotClass}`} />
                              <span>{statusLabel}</span>
                            </span>
                          </div>
                          <p className="break-all font-mono text-xs text-muted-foreground">
                            {workspace.isLocal ? "Uses the current page origin." : workspace.wsUrl}
                          </p>
                          {!workspace.isLocal && workspace.authToken.trim().length > 0 && (
                            <p className="font-mono text-[11px] text-muted-foreground/80">
                              Key: {"*".repeat(Math.max(8, workspace.authToken.trim().length - 4))}
                              {workspace.authToken.trim().slice(-4)}
                            </p>
                          )}
                          {!workspace.isLocal && managedDeployment && (
                            <p className="text-[11px] text-muted-foreground/80">
                              SSH{" "}
                              {managedDeployment.username ? `${managedDeployment.username}@` : ""}
                              {managedDeployment.host}
                              {managedDeployment.port !== undefined
                                ? `:${managedDeployment.port}`
                                : ""}
                              {managedDeployment.serviceName
                                ? ` via ${managedDeployment.serviceName}`
                                : ""}
                              {managedWorkspaceVersion
                                ? `, deployed ${managedWorkspaceVersion}`
                                : ""}
                              {desktopCurrentVersion && needsManagedUpdate
                                ? `, desktop ${desktopCurrentVersion}`
                                : ""}
                            </p>
                          )}
                          {!workspace.isLocal && !managedDeployment && sshConnection && (
                            <p className="text-[11px] text-muted-foreground/80">
                              IDE over SSH via{" "}
                              {sshConnection.username ? `${sshConnection.username}@` : ""}
                              {sshConnection.host}
                              {sshConnection.port !== undefined ? `:${sshConnection.port}` : ""}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          {!workspace.isLocal && managedDeployment && (
                            <Button
                              size="sm"
                              variant={needsManagedUpdate ? "default" : "outline"}
                              onClick={() => redeployManagedWorkspaceMutation.mutate(workspace.id)}
                              disabled={isUpdatingManagedWorkspace}
                            >
                              <RefreshCcwIcon className="mr-1 size-3.5" />
                              {isUpdatingManagedWorkspace
                                ? "Updating..."
                                : needsManagedUpdate
                                  ? "Update"
                                  : "Redeploy"}
                            </Button>
                          )}
                          {!isActive && (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setActiveWorkspace(workspace.id)}
                            >
                              <CheckIcon className="mr-1 size-3.5" />
                              Use
                            </Button>
                          )}
                          {!workspace.isLocal && (
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => removeWorkspace(workspace.id)}
                            >
                              <Trash2Icon className="mr-1 size-3.5" />
                              Remove
                            </Button>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}

                <div className="rounded-xl border border-dashed border-border p-4">
                  <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <GlobeIcon className="size-4 text-muted-foreground" />
                        <h3 className="text-sm font-medium text-foreground">Add workspace</h3>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Paste a remote server URL and key, or prefill the form from the current
                        server invitation below.
                      </p>
                    </div>
                    <div
                      className={`flex items-center gap-1 text-xs ${workspaceStatusTextClassName(activeWorkspaceConnectionState)}`}
                    >
                      <span
                        className={`size-1.5 rounded-full ${workspaceStatusDotClassName(activeWorkspaceConnectionState)}`}
                      />
                      <span>{workspaceStatusLabel(activeWorkspaceConnectionState)}</span>
                    </div>
                  </div>

                  {workspaceAccess && (
                    <div className="mb-4 rounded-lg border border-border/80 bg-background/60 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <KeyRoundIcon className="size-4 text-muted-foreground" />
                            <h4 className="text-sm font-medium text-foreground">
                              Current server invitation
                            </h4>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Use this endpoint and key when adding this server as a workspace from
                            another T3 Code client.
                          </p>
                        </div>
                      </div>

                      <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
                        <code className="min-w-0 flex-1 break-all text-xs text-foreground">
                          {workspaceAccess.token}
                        </code>
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            void copyWorkspaceAccessValue(workspaceAccess.token, "Workspace key")
                          }
                        >
                          <CopyIcon className="mr-1 size-3.5" />
                          Copy key
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={
                            workspaceAccess.tokenSource !== "generated" ||
                            rotateWorkspaceAccessMutation.isPending
                          }
                          onClick={() => {
                            setWorkspaceAccessMessage(null);
                            rotateWorkspaceAccessMutation.mutate();
                          }}
                        >
                          <RefreshCcwIcon className="mr-1 size-3.5" />
                          {rotateWorkspaceAccessMutation.isPending ? "Rotating..." : "Rotate key"}
                        </Button>
                      </div>

                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {workspaceAccess.tokenSource === "configured"
                          ? "This key is controlled by server startup config and cannot be rotated here."
                          : workspaceAccess.loopbackBypassEnabled
                            ? "Loopback clients can connect without the key. Non-loopback clients must provide it."
                            : "All clients must provide this key."}
                      </p>

                      {workspaceAccess.tls.mode === "self-signed" &&
                        workspaceAccess.tls.fingerprintSha256 && (
                          <div className="mt-3 rounded-lg border border-border/80 bg-background px-3 py-2">
                            <div className="flex flex-wrap items-start justify-between gap-2">
                              <div>
                                <p className="text-xs font-medium text-foreground">
                                  Self-signed TLS certificate
                                </p>
                                {workspaceAccess.tls.validTo && (
                                  <p className="mt-1 text-[11px] text-muted-foreground">
                                    Valid until{" "}
                                    {new Date(workspaceAccess.tls.validTo).toLocaleString()}
                                  </p>
                                )}
                              </div>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={rotateWorkspaceTlsCertificateMutation.isPending}
                                onClick={() => {
                                  setWorkspaceAccessMessage(null);
                                  rotateWorkspaceTlsCertificateMutation.mutate();
                                }}
                              >
                                <RefreshCcwIcon className="mr-1 size-3.5" />
                                {rotateWorkspaceTlsCertificateMutation.isPending
                                  ? "Rotating..."
                                  : "Rotate certificate"}
                              </Button>
                            </div>
                            <code className="mt-1 block break-all text-[11px] text-muted-foreground">
                              {workspaceAccess.tls.fingerprintSha256}
                            </code>
                            <p className="mt-2 text-[11px] text-muted-foreground">
                              Desktop clients can trust this fingerprint during add-workspace setup.
                              Browser clients must trust the certificate in the browser first.
                            </p>
                          </div>
                        )}

                      <div className="mt-3 space-y-2">
                        {workspaceAccess.endpoints.map((endpoint) => (
                          <div
                            key={endpoint.wsUrl}
                            className="flex flex-wrap items-center gap-2 rounded-lg border border-border/80 bg-background px-3 py-2"
                          >
                            <span className="rounded-full bg-secondary px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                              {endpoint.scope}
                            </span>
                            <span className="text-xs text-foreground">{endpoint.label}</span>
                            <code className="min-w-0 flex-1 break-all text-xs text-muted-foreground">
                              {endpoint.wsUrl}
                            </code>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setWorkspaceNameInput((current) =>
                                  current.trim().length > 0 ? current : endpoint.label,
                                );
                                setWorkspaceUrlInput(endpoint.wsUrl);
                                setWorkspaceTokenInput(workspaceAccess.token);
                                setWorkspaceError(null);
                                setWorkspaceCertificate(null);
                                setWorkspaceCertificateMessage(
                                  workspaceAccess.tls.mode === "self-signed"
                                    ? "Inspect and trust this server certificate before saving the workspace."
                                    : null,
                                );
                              }}
                            >
                              Use
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                void addWorkspaceFromInvitation({
                                  label: endpoint.label,
                                  wsUrl: endpoint.wsUrl,
                                });
                              }}
                            >
                              <PlusIcon className="mr-1 size-3.5" />
                              Add
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() =>
                                void copyWorkspaceAccessValue(endpoint.wsUrl, "Workspace URL")
                              }
                            >
                              <CopyIcon className="mr-1 size-3.5" />
                              Copy URL
                            </Button>
                          </div>
                        ))}
                      </div>

                      {workspaceAccessMessage && (
                        <p className="mt-3 text-xs text-muted-foreground">
                          {workspaceAccessMessage}
                        </p>
                      )}
                    </div>
                  )}

                  {isElectron && (
                    <div className="mb-4 rounded-lg border border-border/80 bg-background/60 p-4">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <div className="flex items-center gap-2">
                            <ServerCogIcon className="size-4 text-muted-foreground" />
                            <h4 className="text-sm font-medium text-foreground">
                              Deploy remote workspace
                            </h4>
                          </div>
                          <p className="text-xs text-muted-foreground">
                            Use SSH once to install or update a self-contained Linux server binary,
                            register a <code>systemd --user</code> service, start it, and save the
                            workspace back into this desktop app. Key-based SSH is required.
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={deployWorkspaceMutation.isPending}
                          onClick={() => {
                            setDeployWorkspaceMessage(null);
                            deployWorkspaceMutation.mutate();
                          }}
                        >
                          <ServerCogIcon className="mr-1 size-3.5" />
                          {deployWorkspaceMutation.isPending ? "Deploying..." : "Deploy / Update"}
                        </Button>
                      </div>

                      <div className="mt-4 grid gap-3 md:grid-cols-2">
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">
                            Workspace label
                          </label>
                          <Input
                            value={deployWorkspaceNameInput}
                            onChange={(event) => setDeployWorkspaceNameInput(event.target.value)}
                            placeholder="GPU box"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">
                            SSH host
                          </label>
                          <Input
                            value={deployWorkspaceHostInput}
                            onChange={(event) => setDeployWorkspaceHostInput(event.target.value)}
                            placeholder="192.168.1.42"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">
                            SSH username
                          </label>
                          <Input
                            value={deployWorkspaceUsernameInput}
                            onChange={(event) =>
                              setDeployWorkspaceUsernameInput(event.target.value)
                            }
                            placeholder="ubuntu"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">
                            SSH port
                          </label>
                          <Input
                            value={deployWorkspaceSshPortInput}
                            onChange={(event) => setDeployWorkspaceSshPortInput(event.target.value)}
                            placeholder="22"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">
                            Workspace connect host
                          </label>
                          <Input
                            value={deployWorkspaceConnectHostInput}
                            onChange={(event) =>
                              setDeployWorkspaceConnectHostInput(event.target.value)
                            }
                            placeholder="Leave blank to use the SSH host"
                          />
                        </div>
                        <div className="space-y-1">
                          <label className="text-xs font-medium text-muted-foreground">
                            Workspace server port
                          </label>
                          <Input
                            value={deployWorkspaceServerPortInput}
                            onChange={(event) =>
                              setDeployWorkspaceServerPortInput(event.target.value)
                            }
                            placeholder="3773"
                          />
                        </div>
                      </div>

                      {deployWorkspaceMessage && (
                        <p className="mt-3 text-xs text-muted-foreground">
                          {deployWorkspaceMessage}
                        </p>
                      )}
                    </div>
                  )}

                  <div className="grid gap-3 md:grid-cols-2">
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">Name</label>
                      <Input
                        value={workspaceNameInput}
                        onChange={(event) => setWorkspaceNameInput(event.target.value)}
                        placeholder="Toronto build box"
                      />
                    </div>
                    <div className="space-y-1">
                      <label className="text-xs font-medium text-muted-foreground">
                        Server URL
                      </label>
                      <Input
                        value={workspaceUrlInput}
                        onChange={(event) => {
                          setWorkspaceUrlInput(event.target.value);
                          setWorkspaceError(null);
                          setWorkspaceCertificate(null);
                          setWorkspaceCertificateMessage(null);
                        }}
                        placeholder="wss://remote.example.com"
                      />
                    </div>
                  </div>
                  <div className="mt-3 space-y-1">
                    <label className="text-xs font-medium text-muted-foreground">Access key</label>
                    <Input
                      type="password"
                      value={workspaceTokenInput}
                      onChange={(event) => setWorkspaceTokenInput(event.target.value)}
                      placeholder="Paste the workspace key from the remote server"
                    />
                  </div>
                  <div className="mt-3 rounded-lg border border-border/80 bg-background/60 p-3">
                    <div className="space-y-1">
                      <p className="text-xs font-medium text-foreground">SSH settings</p>
                      <p className="text-xs text-muted-foreground">
                        Optional. Add these when you want the desktop app to open this remote
                        workspace in a local IDE over SSH.
                      </p>
                    </div>
                    <div className="mt-3 grid gap-3 md:grid-cols-3">
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">
                          SSH host
                        </label>
                        <Input
                          value={workspaceSshHostInput}
                          onChange={(event) => setWorkspaceSshHostInput(event.target.value)}
                          placeholder="remote-host"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">
                          SSH username
                        </label>
                        <Input
                          value={workspaceSshUsernameInput}
                          onChange={(event) => setWorkspaceSshUsernameInput(event.target.value)}
                          placeholder="Optional"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-xs font-medium text-muted-foreground">
                          SSH port
                        </label>
                        <Input
                          value={workspaceSshPortInput}
                          onChange={(event) => setWorkspaceSshPortInput(event.target.value)}
                          placeholder="22"
                        />
                      </div>
                    </div>
                  </div>
                  {normalizedWorkspaceUrl?.startsWith("wss://") && (
                    <div className="mt-3 rounded-lg border border-border/80 bg-background/60 p-3">
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="space-y-1">
                          <p className="text-xs font-medium text-foreground">Server certificate</p>
                          <p className="text-xs text-muted-foreground">
                            {isElectron
                              ? "Inspect the remote server certificate before saving this workspace. Self-signed certificates can be pinned to this device."
                              : "Browser builds cannot trust self-signed certificates automatically. Trust the server certificate in your browser before connecting."}
                          </p>
                        </div>
                        {isElectron && (
                          <div className="flex items-center gap-2">
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={inspectWorkspaceCertificateMutation.isPending}
                              onClick={() => {
                                void inspectWorkspaceCertificate();
                              }}
                            >
                              <RefreshCcwIcon className="mr-1 size-3.5" />
                              {inspectWorkspaceCertificateMutation.isPending
                                ? "Inspecting..."
                                : "Inspect certificate"}
                            </Button>
                            {workspaceCertificate &&
                              workspaceCertificate.url === normalizedWorkspaceUrl &&
                              workspaceCertificate.selfSigned &&
                              !workspaceCertificate.trusted && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  disabled={trustWorkspaceCertificateMutation.isPending}
                                  onClick={() => {
                                    void trustWorkspaceCertificateMutation.mutateAsync({
                                      url: workspaceCertificate.url,
                                      fingerprintSha256: workspaceCertificate.fingerprintSha256,
                                    });
                                  }}
                                >
                                  <CheckIcon className="mr-1 size-3.5" />
                                  {trustWorkspaceCertificateMutation.isPending
                                    ? "Trusting..."
                                    : "Trust fingerprint"}
                                </Button>
                              )}
                          </div>
                        )}
                      </div>

                      {workspaceCertificate &&
                        workspaceCertificate.url === normalizedWorkspaceUrl && (
                          <div className="mt-3 space-y-2 rounded-lg border border-border bg-background px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                              <span className="rounded-full bg-secondary px-2 py-0.5 font-medium uppercase tracking-wide">
                                {workspaceCertificate.trusted
                                  ? "trusted"
                                  : workspaceCertificate.verificationError === null
                                    ? "system"
                                    : workspaceCertificate.selfSigned
                                      ? "self-signed"
                                      : "untrusted"}
                              </span>
                              <span>{workspaceCertificate.hostname}</span>
                            </div>
                            <code className="block break-all text-[11px] text-foreground">
                              {workspaceCertificate.fingerprintSha256}
                            </code>
                            <p className="text-[11px] text-muted-foreground">
                              Subject: {workspaceCertificate.subjectName ?? "Unknown"} · Issuer:{" "}
                              {workspaceCertificate.issuerName ?? "Unknown"}
                            </p>
                            {workspaceCertificate.verificationError && (
                              <p className="text-[11px] text-muted-foreground">
                                Verification error: {workspaceCertificate.verificationError}
                              </p>
                            )}
                          </div>
                        )}

                      {workspaceCertificateMessage && (
                        <p className="mt-3 text-xs text-muted-foreground">
                          {workspaceCertificateMessage}
                        </p>
                      )}
                    </div>
                  )}
                  {workspaceError && (
                    <p className="mt-3 text-xs text-destructive">{workspaceError}</p>
                  )}
                  <div className="mt-3 flex justify-end">
                    <Button
                      disabled={trustWorkspaceCertificateMutation.isPending}
                      onClick={() => {
                        void addWorkspace();
                      }}
                    >
                      <PlusIcon className="mr-1 size-4" />
                      Add workspace
                    </Button>
                  </div>
                </div>
              </div>
            </section>

            <ProjectExecutionSettingsSection projects={projects} />

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Appearance</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Choose how T3 Code handles light and dark mode.
                </p>
              </div>

              <div className="space-y-2" role="radiogroup" aria-label="Theme preference">
                {THEME_OPTIONS.map((option) => {
                  const selected = theme === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      role="radio"
                      aria-checked={selected}
                      className={`flex w-full items-start justify-between rounded-lg border px-3 py-2 text-left transition-colors ${
                        selected
                          ? "border-primary/60 bg-primary/8 text-foreground"
                          : "border-border bg-background text-muted-foreground hover:bg-accent"
                      }`}
                      onClick={() => setTheme(option.value)}
                    >
                      <span className="flex flex-col">
                        <span className="text-sm font-medium">{option.label}</span>
                        <span className="text-xs">{option.description}</span>
                      </span>
                      {selected ? (
                        <span className="rounded bg-primary/14 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
                          Selected
                        </span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              <p className="mt-4 text-xs text-muted-foreground">
                Active theme: <span className="font-medium text-foreground">{resolvedTheme}</span>
              </p>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Codex App Server</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  These overrides apply to new sessions and let you use a non-default Codex install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="codex-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Codex binary path</span>
                  <Input
                    id="codex-binary-path"
                    value={codexBinaryPath}
                    onChange={(event) => updateSettings({ codexBinaryPath: event.target.value })}
                    placeholder="codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>codex</code> from your PATH.
                  </span>
                </label>

                <label htmlFor="codex-home-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">CODEX_HOME path</span>
                  <Input
                    id="codex-home-path"
                    value={codexHomePath}
                    onChange={(event) => updateSettings({ codexHomePath: event.target.value })}
                    placeholder="/Users/you/.codex"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Optional custom Codex home/config directory.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <p>
                    Binary source:{" "}
                    <span className="font-medium text-foreground">{codexBinaryPath || "PATH"}</span>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        codexBinaryPath: defaults.codexBinaryPath,
                        codexHomePath: defaults.codexHomePath,
                      })
                    }
                  >
                    Reset codex overrides
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Claude Code CLI</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  This override applies to new Claude sessions and lets you use a non-default Claude
                  Code install.
                </p>
              </div>

              <div className="space-y-4">
                <label htmlFor="claude-binary-path" className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Claude binary path</span>
                  <Input
                    id="claude-binary-path"
                    value={claudeBinaryPath}
                    onChange={(event) => updateSettings({ claudeBinaryPath: event.target.value })}
                    placeholder="claude"
                    spellCheck={false}
                  />
                  <span className="text-xs text-muted-foreground">
                    Leave blank to use <code>claude</code> from your PATH.
                  </span>
                </label>

                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <p>
                    Binary source:{" "}
                    <span className="font-medium text-foreground">
                      {claudeBinaryPath || "PATH"}
                    </span>
                  </p>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        claudeBinaryPath: defaults.claudeBinaryPath,
                      })
                    }
                  >
                    Reset Claude override
                  </Button>
                </div>
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Models</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Save additional provider model slugs so they appear in the chat model picker and
                  `/model` command suggestions.
                </p>
              </div>

              <div className="space-y-5">
                <label className="block space-y-1">
                  <span className="text-xs font-medium text-foreground">Default service tier</span>
                  <Select
                    items={APP_SERVICE_TIER_OPTIONS.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={codexServiceTier}
                    onValueChange={(value) => {
                      if (!value) return;
                      updateSettings({ codexServiceTier: value });
                    }}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectPopup alignItemWithTrigger={false}>
                      {APP_SERVICE_TIER_OPTIONS.map((option) => (
                        <SelectItem key={option.value} value={option.value}>
                          <div className="flex min-w-0 items-center gap-2">
                            {option.value === "fast" ? (
                              <ZapIcon className="size-3.5 text-amber-500" />
                            ) : (
                              <span className="size-3.5 shrink-0" aria-hidden="true" />
                            )}
                            <span className="truncate">{option.label}</span>
                          </div>
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {APP_SERVICE_TIER_OPTIONS.find((option) => option.value === codexServiceTier)
                      ?.description ?? "Use Codex defaults without forcing a service tier."}
                  </span>
                </label>

                {MODEL_PROVIDER_SETTINGS.map((providerSettings) => {
                  const provider = providerSettings.provider;
                  const customModels = getCustomModelsForProvider(settings, provider);
                  const customModelInput = customModelInputByProvider[provider];
                  const customModelError = customModelErrorByProvider[provider] ?? null;
                  return (
                    <div
                      key={provider}
                      className="rounded-xl border border-border bg-background/50 p-4"
                    >
                      <div className="mb-4">
                        <h3 className="text-sm font-medium text-foreground">
                          {providerSettings.title}
                        </h3>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {providerSettings.description}
                        </p>
                      </div>

                      <div className="space-y-4">
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                          <label
                            htmlFor={`custom-model-slug-${provider}`}
                            className="block flex-1 space-y-1"
                          >
                            <span className="text-xs font-medium text-foreground">
                              Custom model slug
                            </span>
                            <Input
                              id={`custom-model-slug-${provider}`}
                              value={customModelInput}
                              onChange={(event) => {
                                const value = event.target.value;
                                setCustomModelInputByProvider((existing) => ({
                                  ...existing,
                                  [provider]: value,
                                }));
                                if (customModelError) {
                                  setCustomModelErrorByProvider((existing) => ({
                                    ...existing,
                                    [provider]: null,
                                  }));
                                }
                              }}
                              onKeyDown={(event) => {
                                if (event.key !== "Enter") return;
                                event.preventDefault();
                                addCustomModel(provider);
                              }}
                              placeholder={providerSettings.placeholder}
                              spellCheck={false}
                            />
                            <span className="text-xs text-muted-foreground">
                              Example: <code>{providerSettings.example}</code>
                            </span>
                          </label>

                          <Button
                            className="sm:mt-6"
                            type="button"
                            onClick={() => addCustomModel(provider)}
                          >
                            Add model
                          </Button>
                        </div>

                        {customModelError ? (
                          <p className="text-xs text-destructive">{customModelError}</p>
                        ) : null}

                        <div className="space-y-2">
                          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                            <p>Saved custom models: {customModels.length}</p>
                            {customModels.length > 0 ? (
                              <Button
                                size="xs"
                                variant="outline"
                                onClick={() =>
                                  updateSettings(
                                    patchCustomModels(provider, [
                                      ...getDefaultCustomModelsForProvider(defaults, provider),
                                    ]),
                                  )
                                }
                              >
                                Reset custom models
                              </Button>
                            ) : null}
                          </div>

                          {customModels.length > 0 ? (
                            <div className="space-y-2">
                              {customModels.map((slug) => (
                                <div
                                  key={`${provider}:${slug}`}
                                  className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2"
                                >
                                  <div className="flex min-w-0 flex-1 items-center gap-2">
                                    {provider === "codex" &&
                                    shouldShowFastTierIcon(slug, codexServiceTier) ? (
                                      <ZapIcon className="size-3.5 shrink-0 text-amber-500" />
                                    ) : null}
                                    <code className="min-w-0 flex-1 truncate text-xs text-foreground">
                                      {slug}
                                    </code>
                                  </div>
                                  <Button
                                    size="xs"
                                    variant="ghost"
                                    onClick={() => removeCustomModel(provider, slug)}
                                  >
                                    Remove
                                  </Button>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs text-muted-foreground">
                              No custom models saved yet.
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Responses</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Control how assistant output is rendered during a turn.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Stream assistant messages</p>
                  <p className="text-xs text-muted-foreground">
                    Show token-by-token output while a response is in progress.
                  </p>
                </div>
                <Switch
                  checked={settings.enableAssistantStreaming}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      enableAssistantStreaming: Boolean(checked),
                    })
                  }
                  aria-label="Stream assistant messages"
                />
              </div>

              {settings.enableAssistantStreaming !== defaults.enableAssistantStreaming ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        enableAssistantStreaming: defaults.enableAssistantStreaming,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Keybindings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Open the persisted <code>keybindings.json</code> file to edit advanced bindings
                  directly.
                </p>
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs font-medium text-foreground">Config file path</p>
                    <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">
                      {keybindingsConfigPath ?? "Resolving keybindings path..."}
                    </p>
                  </div>
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!keybindingsConfigPath || isOpeningKeybindings}
                    onClick={openKeybindingsFile}
                  >
                    {isOpeningKeybindings ? "Opening..." : "Open keybindings.json"}
                  </Button>
                </div>

                <p className="text-xs text-muted-foreground">
                  Opens in your preferred editor selection.
                </p>
                {openKeybindingsError ? (
                  <p className="text-xs text-destructive">{openKeybindingsError}</p>
                ) : null}
              </div>
            </section>

            <section className="rounded-2xl border border-border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium text-foreground">Safety</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Additional guardrails for destructive local actions.
                </p>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
                <div>
                  <p className="text-sm font-medium text-foreground">Confirm thread deletion</p>
                  <p className="text-xs text-muted-foreground">
                    Ask for confirmation before deleting a thread and its chat history.
                  </p>
                </div>
                <Switch
                  checked={settings.confirmThreadDelete}
                  onCheckedChange={(checked) =>
                    updateSettings({
                      confirmThreadDelete: Boolean(checked),
                    })
                  }
                  aria-label="Confirm thread deletion"
                />
              </div>

              {settings.confirmThreadDelete !== defaults.confirmThreadDelete ? (
                <div className="mt-3 flex justify-end">
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      updateSettings({
                        confirmThreadDelete: defaults.confirmThreadDelete,
                      })
                    }
                  >
                    Restore default
                  </Button>
                </div>
              ) : null}
            </section>
          </div>
        </div>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/settings")({
  component: SettingsRouteView,
});
