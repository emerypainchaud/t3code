import type {
  GitCheckoutInput,
  GitCreateBranchInput,
  GitPreparePullRequestThreadInput,
  GitPreparePullRequestThreadResult,
  GitPullRequestRefInput,
  GitCreateWorktreeInput,
  GitCreateWorktreeResult,
  GitInitInput,
  GitListBranchesInput,
  GitListBranchesResult,
  GitPullInput,
  GitPullResult,
  GitRemoveWorktreeInput,
  GitResolvePullRequestResult,
  GitRunStackedActionInput,
  GitRunStackedActionResult,
  GitStatusInput,
  GitStatusResult,
} from "./git";
import type {
  ProjectListDirectoryInput,
  ProjectListDirectoryResult,
  ProjectSearchEntriesInput,
  ProjectSearchEntriesResult,
  ProjectWriteFileInput,
  ProjectWriteFileResult,
} from "./project";
import type {
  ServerConfig,
  ServerRotateWorkspaceAccessTokenResult,
  ServerRotateWorkspaceTlsCertificateResult,
  ServerUpsertKeybindingInput,
  ServerUpsertKeybindingResult,
} from "./server";
import type {
  TerminalClearInput,
  TerminalCloseInput,
  TerminalEvent,
  TerminalOpenInput,
  TerminalResizeInput,
  TerminalRestartInput,
  TerminalSessionSnapshot,
  TerminalWriteInput,
} from "./terminal";
import type {
  ClientOrchestrationCommand,
  OrchestrationGetFullThreadDiffInput,
  OrchestrationGetFullThreadDiffResult,
  OrchestrationGetTurnDiffInput,
  OrchestrationGetTurnDiffResult,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "./orchestration";
import { EditorId } from "./editor";

export interface ContextMenuItem<T extends string = string> {
  id: T;
  label: string;
  destructive?: boolean;
}

export type DesktopUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "error";

export type DesktopRuntimeArch = "arm64" | "x64" | "other";
export type DesktopTheme = "light" | "dark" | "system";

export interface DesktopRuntimeInfo {
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
}

export interface DesktopUpdateState {
  enabled: boolean;
  status: DesktopUpdateStatus;
  currentVersion: string;
  hostArch: DesktopRuntimeArch;
  appArch: DesktopRuntimeArch;
  runningUnderArm64Translation: boolean;
  availableVersion: string | null;
  downloadedVersion: string | null;
  downloadPercent: number | null;
  checkedAt: string | null;
  message: string | null;
  errorContext: "check" | "download" | "install" | null;
  canRetry: boolean;
}

export interface DesktopUpdateActionResult {
  accepted: boolean;
  completed: boolean;
  state: DesktopUpdateState;
}

export interface DesktopRemoteTlsCertificateInspection {
  url: string;
  hostname: string;
  fingerprintSha256: string;
  subjectName: string | null;
  issuerName: string | null;
  validFrom: string | null;
  validTo: string | null;
  verificationError: string | null;
  trusted: boolean;
  selfSigned: boolean;
}

export interface DesktopTrustRemoteTlsCertificateInput {
  url: string;
  fingerprintSha256: string;
}

export interface DesktopDeployRemoteWorkspaceInput {
  host: string;
  username?: string;
  port?: number;
  connectHost?: string;
  serverPort?: number;
  workspaceName?: string;
}

export interface DesktopDeployRemoteWorkspaceResult {
  workspaceName: string;
  wsUrl: string;
  authToken: string;
  serviceName: string;
  remoteArch: "x64" | "arm64";
  lingerEnabled: boolean | null;
  deployedVersion: string | null;
  capabilities: {
    git: boolean;
    codex: boolean;
    claudeCode: boolean;
  };
  warnings: string[];
}

export interface DesktopOpenInLocalEditorViaSshInput {
  editor: EditorId;
  host: string;
  username?: string;
  port?: number;
  remotePath: string;
  targetKind: "file" | "directory";
}

export interface DesktopOpenInLocalEditorViaSshResult {
  opened: boolean;
  message: string;
  command?: string;
}

export interface DesktopBridge {
  getWsUrl: () => string | null;
  getLocalSshOpenEditors: () => EditorId[];
  getPersistedAppSettings: () => string | null;
  setPersistedAppSettings: (raw: string) => Promise<void>;
  onPersistedAppSettings: (listener: (raw: string | null) => void) => () => void;
  pickFolder: () => Promise<string | null>;
  confirm: (message: string) => Promise<boolean>;
  setTheme: (theme: DesktopTheme) => Promise<void>;
  showContextMenu: <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position?: { x: number; y: number },
  ) => Promise<T | null>;
  openExternal: (url: string) => Promise<boolean>;
  onMenuAction: (listener: (action: string) => void) => () => void;
  getUpdateState: () => Promise<DesktopUpdateState>;
  downloadUpdate: () => Promise<DesktopUpdateActionResult>;
  installUpdate: () => Promise<DesktopUpdateActionResult>;
  onUpdateState: (listener: (state: DesktopUpdateState) => void) => () => void;
  inspectRemoteTlsCertificate: (url: string) => Promise<DesktopRemoteTlsCertificateInspection>;
  trustRemoteTlsCertificate: (input: DesktopTrustRemoteTlsCertificateInput) => Promise<void>;
  deployRemoteWorkspaceServer: (
    input: DesktopDeployRemoteWorkspaceInput,
  ) => Promise<DesktopDeployRemoteWorkspaceResult>;
  openInLocalEditorViaSsh: (
    input: DesktopOpenInLocalEditorViaSshInput,
  ) => Promise<DesktopOpenInLocalEditorViaSshResult>;
}

export interface NativeApi {
  dialogs: {
    pickFolder: () => Promise<string | null>;
    confirm: (message: string) => Promise<boolean>;
  };
  terminal: {
    open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
    write: (input: TerminalWriteInput) => Promise<void>;
    resize: (input: TerminalResizeInput) => Promise<void>;
    clear: (input: TerminalClearInput) => Promise<void>;
    restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
    close: (input: TerminalCloseInput) => Promise<void>;
    onEvent: (callback: (event: TerminalEvent) => void) => () => void;
  };
  projects: {
    listDirectory: (input: ProjectListDirectoryInput) => Promise<ProjectListDirectoryResult>;
    searchEntries: (input: ProjectSearchEntriesInput) => Promise<ProjectSearchEntriesResult>;
    writeFile: (input: ProjectWriteFileInput) => Promise<ProjectWriteFileResult>;
  };
  shell: {
    openInEditor: (cwd: string, editor: EditorId) => Promise<void>;
    openInLocalEditorViaSsh: (
      input: DesktopOpenInLocalEditorViaSshInput,
    ) => Promise<DesktopOpenInLocalEditorViaSshResult>;
    openExternal: (url: string) => Promise<void>;
  };
  git: {
    // Existing branch/worktree API
    listBranches: (input: GitListBranchesInput) => Promise<GitListBranchesResult>;
    createWorktree: (input: GitCreateWorktreeInput) => Promise<GitCreateWorktreeResult>;
    removeWorktree: (input: GitRemoveWorktreeInput) => Promise<void>;
    createBranch: (input: GitCreateBranchInput) => Promise<void>;
    checkout: (input: GitCheckoutInput) => Promise<void>;
    init: (input: GitInitInput) => Promise<void>;
    resolvePullRequest: (input: GitPullRequestRefInput) => Promise<GitResolvePullRequestResult>;
    preparePullRequestThread: (
      input: GitPreparePullRequestThreadInput,
    ) => Promise<GitPreparePullRequestThreadResult>;
    // Stacked action API
    pull: (input: GitPullInput) => Promise<GitPullResult>;
    status: (input: GitStatusInput) => Promise<GitStatusResult>;
    runStackedAction: (input: GitRunStackedActionInput) => Promise<GitRunStackedActionResult>;
  };
  contextMenu: {
    show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  };
  server: {
    getConfig: () => Promise<ServerConfig>;
    upsertKeybinding: (input: ServerUpsertKeybindingInput) => Promise<ServerUpsertKeybindingResult>;
    rotateWorkspaceAccessToken: () => Promise<ServerRotateWorkspaceAccessTokenResult>;
    rotateWorkspaceTlsCertificate: () => Promise<ServerRotateWorkspaceTlsCertificateResult>;
    inspectRemoteTlsCertificate: (url: string) => Promise<DesktopRemoteTlsCertificateInspection>;
    trustRemoteTlsCertificate: (input: DesktopTrustRemoteTlsCertificateInput) => Promise<void>;
    deployRemoteWorkspaceServer: (
      input: DesktopDeployRemoteWorkspaceInput,
    ) => Promise<DesktopDeployRemoteWorkspaceResult>;
  };
  orchestration: {
    getSnapshot: () => Promise<OrchestrationReadModel>;
    dispatchCommand: (command: ClientOrchestrationCommand) => Promise<{ sequence: number }>;
    getTurnDiff: (input: OrchestrationGetTurnDiffInput) => Promise<OrchestrationGetTurnDiffResult>;
    getFullThreadDiff: (
      input: OrchestrationGetFullThreadDiffInput,
    ) => Promise<OrchestrationGetFullThreadDiffResult>;
    replayEvents: (fromSequenceExclusive: number) => Promise<OrchestrationEvent[]>;
    onDomainEvent: (callback: (event: OrchestrationEvent) => void) => () => void;
  };
}
