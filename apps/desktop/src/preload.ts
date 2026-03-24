import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "@t3tools/contracts";

const PICK_FOLDER_CHANNEL = "desktop:pick-folder";
const CONFIRM_CHANNEL = "desktop:confirm";
const SET_THEME_CHANNEL = "desktop:set-theme";
const CONTEXT_MENU_CHANNEL = "desktop:context-menu";
const OPEN_EXTERNAL_CHANNEL = "desktop:open-external";
const MENU_ACTION_CHANNEL = "desktop:menu-action";
const UPDATE_STATE_CHANNEL = "desktop:update-state";
const UPDATE_GET_STATE_CHANNEL = "desktop:update-get-state";
const UPDATE_DOWNLOAD_CHANNEL = "desktop:update-download";
const UPDATE_INSTALL_CHANNEL = "desktop:update-install";
const INSPECT_REMOTE_TLS_CERTIFICATE_CHANNEL = "desktop:inspect-remote-tls-certificate";
const TRUST_REMOTE_TLS_CERTIFICATE_CHANNEL = "desktop:trust-remote-tls-certificate";
const DEPLOY_REMOTE_WORKSPACE_SERVER_CHANNEL = "desktop:deploy-remote-workspace-server";
const OPEN_IN_LOCAL_EDITOR_VIA_SSH_CHANNEL = "desktop:open-in-local-editor-via-ssh";
const GET_LOCAL_SSH_OPEN_EDITORS_CHANNEL = "desktop:get-local-ssh-open-editors";
const APP_SETTINGS_GET_CHANNEL = "desktop:app-settings-get";
const APP_SETTINGS_SET_CHANNEL = "desktop:app-settings-set";
const APP_SETTINGS_CHANGED_CHANNEL = "desktop:app-settings-changed";
const wsUrl = process.env.T3CODE_DESKTOP_WS_URL ?? null;
let persistedAppSettings = ipcRenderer.sendSync(APP_SETTINGS_GET_CHANNEL) as string | null;

contextBridge.exposeInMainWorld("desktopBridge", {
  getWsUrl: () => wsUrl,
  getLocalSshOpenEditors: () =>
    ipcRenderer.sendSync(GET_LOCAL_SSH_OPEN_EDITORS_CHANNEL) as ReturnType<
      DesktopBridge["getLocalSshOpenEditors"]
    >,
  getPersistedAppSettings: () => persistedAppSettings,
  setPersistedAppSettings: async (raw) => {
    persistedAppSettings = raw;
    await ipcRenderer.invoke(APP_SETTINGS_SET_CHANNEL, raw);
  },
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  confirm: (message) => ipcRenderer.invoke(CONFIRM_CHANNEL, message),
  setTheme: (theme) => ipcRenderer.invoke(SET_THEME_CHANNEL, theme),
  showContextMenu: (items, position) => ipcRenderer.invoke(CONTEXT_MENU_CHANNEL, items, position),
  openExternal: (url: string) => ipcRenderer.invoke(OPEN_EXTERNAL_CHANNEL, url),
  onMenuAction: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, action: unknown) => {
      if (typeof action !== "string") return;
      listener(action);
    };

    ipcRenderer.on(MENU_ACTION_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(MENU_ACTION_CHANNEL, wrappedListener);
    };
  },
  getUpdateState: () => ipcRenderer.invoke(UPDATE_GET_STATE_CHANNEL),
  downloadUpdate: () => ipcRenderer.invoke(UPDATE_DOWNLOAD_CHANNEL),
  installUpdate: () => ipcRenderer.invoke(UPDATE_INSTALL_CHANNEL),
  inspectRemoteTlsCertificate: (url) =>
    ipcRenderer.invoke(INSPECT_REMOTE_TLS_CERTIFICATE_CHANNEL, url),
  trustRemoteTlsCertificate: (input) =>
    ipcRenderer.invoke(TRUST_REMOTE_TLS_CERTIFICATE_CHANNEL, input),
  deployRemoteWorkspaceServer: (input) =>
    ipcRenderer.invoke(DEPLOY_REMOTE_WORKSPACE_SERVER_CHANNEL, input),
  openInLocalEditorViaSsh: (input) =>
    ipcRenderer.invoke(OPEN_IN_LOCAL_EDITOR_VIA_SSH_CHANNEL, input),
  onPersistedAppSettings: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, raw: unknown) => {
      if (raw !== null && typeof raw !== "string") return;
      persistedAppSettings = raw;
      listener(raw);
    };

    ipcRenderer.on(APP_SETTINGS_CHANGED_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(APP_SETTINGS_CHANGED_CHANNEL, wrappedListener);
    };
  },
  onUpdateState: (listener) => {
    const wrappedListener = (_event: Electron.IpcRendererEvent, state: unknown) => {
      if (typeof state !== "object" || state === null) return;
      listener(state as Parameters<typeof listener>[0]);
    };

    ipcRenderer.on(UPDATE_STATE_CHANNEL, wrappedListener);
    return () => {
      ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, wrappedListener);
    };
  },
} satisfies DesktopBridge);
