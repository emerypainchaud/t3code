import type {
  ProjectExecutionTarget,
  ProjectListDirectoryResult,
  ProjectSshPreflightResult,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CpuIcon, FolderIcon, HardDriveIcon, SaveIcon, ServerCogIcon } from "lucide-react";

import type { Project } from "../types";
import { newCommandId } from "../lib/utils";
import {
  DEFAULT_PROJECT_EXECUTION_SYNC_IGNORES,
  parseExecutionTargetIgnores,
  projectExecutionTargetDescription,
  projectExecutionTargetLabel,
  serializeExecutionTargetIgnores,
} from "../projectExecutionTarget";
import { ensureNativeApi } from "../nativeApi";
import { Button } from "./ui/button";
import { Input } from "./ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";
import { Textarea } from "./ui/textarea";
import { RemoteDirectoryBrowserDialog } from "./RemoteDirectoryBrowserDialog";

interface ProjectExecutionSettingsSectionProps {
  readonly projects: readonly Project[];
}

interface ProjectExecutionDraft {
  readonly kind: "workspace-local" | "ssh";
  readonly label: string;
  readonly host: string;
  readonly username: string;
  readonly port: string;
  readonly remotePath: string;
  readonly localPath: string;
  readonly ignoresText: string;
}

function draftFromExecutionTarget(target: ProjectExecutionTarget): ProjectExecutionDraft {
  if (target.kind === "workspace-local") {
    return {
      kind: "workspace-local",
      label: "",
      host: "",
      username: "",
      port: "",
      remotePath: "",
      localPath: "",
      ignoresText: serializeExecutionTargetIgnores(DEFAULT_PROJECT_EXECUTION_SYNC_IGNORES),
    };
  }

  return {
    kind: "ssh",
    label: target.label ?? "",
    host: target.host,
    username: target.username ?? "",
    port: target.port ? String(target.port) : "",
    remotePath: target.remotePath,
    localPath: target.sync.localPath,
    ignoresText: serializeExecutionTargetIgnores(target.sync.ignores),
  };
}

function equalExecutionTargets(
  left: ProjectExecutionTarget,
  right: ProjectExecutionTarget,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildExecutionTargetFromDraft(draft: ProjectExecutionDraft):
  | {
      ok: true;
      executionTarget: ProjectExecutionTarget;
    }
  | {
      ok: false;
      error: string;
    } {
  if (draft.kind === "workspace-local") {
    return {
      ok: true,
      executionTarget: { kind: "workspace-local" },
    };
  }

  const host = draft.host.trim();
  const remotePath = draft.remotePath.trim();
  const localPath = draft.localPath.trim();
  if (!host) {
    return { ok: false, error: "SSH host is required." };
  }
  if (!remotePath) {
    return { ok: false, error: "Remote project path is required." };
  }
  if (!localPath) {
    return { ok: false, error: "Workspace mirror path is required." };
  }

  const portText = draft.port.trim();
  let port: number | undefined;
  if (portText.length > 0) {
    const parsed = Number(portText);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return { ok: false, error: "SSH port must be a positive integer." };
    }
    port = parsed;
  }

  return {
    ok: true,
    executionTarget: {
      kind: "ssh",
      label: draft.label.trim() || undefined,
      host,
      username: draft.username.trim() || undefined,
      port,
      remotePath,
      sync: {
        mode: "mutagen",
        localPath,
        ignores: parseExecutionTargetIgnores(draft.ignoresText),
      },
    },
  };
}

function buildSshPreflightInputFromDraft(draft: ProjectExecutionDraft):
  | {
      ok: true;
      input: {
        host: string;
        username?: string;
        port?: number;
        remotePath: string;
        localPathOverride?: string;
        ignores: string[];
      };
    }
  | {
      ok: false;
      error: string;
    } {
  const host = draft.host.trim();
  const remotePath = draft.remotePath.trim();
  if (!host) {
    return { ok: false, error: "SSH host is required." };
  }
  if (!remotePath) {
    return { ok: false, error: "Remote project path is required." };
  }

  const portText = draft.port.trim();
  let port: number | undefined;
  if (portText.length > 0) {
    const parsed = Number(portText);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      return { ok: false, error: "SSH port must be a positive integer." };
    }
    port = parsed;
  }

  return {
    ok: true,
    input: {
      host,
      ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
      ...(port !== undefined ? { port } : {}),
      remotePath,
      ...(draft.localPath.trim() ? { localPathOverride: draft.localPath.trim() } : {}),
      ignores: parseExecutionTargetIgnores(draft.ignoresText),
    },
  };
}

function buildSshDirectoryInputFromDraft(draft: ProjectExecutionDraft):
  | {
      ok: true;
      input: {
        host: string;
        username?: string;
        port?: number;
        path: string;
        limit: number;
      };
    }
  | {
      ok: false;
      error: string;
    } {
  const host = draft.host.trim();
  if (!host) {
    return { ok: false, error: "SSH host is required." };
  }

  const portText = draft.port.trim();
  let port: number | undefined;
  if (portText.length > 0) {
    const parsed = Number(portText);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
      return { ok: false, error: "SSH port must be a positive integer." };
    }
    port = parsed;
  }

  return {
    ok: true,
    input: {
      host,
      ...(draft.username.trim() ? { username: draft.username.trim() } : {}),
      ...(port !== undefined ? { port } : {}),
      path: draft.remotePath.trim() || "/",
      limit: 200,
    },
  };
}

function ProjectExecutionCard(props: { readonly project: Project }) {
  const [draft, setDraft] = useState<ProjectExecutionDraft>(() =>
    draftFromExecutionTarget(props.project.executionTarget),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [isChecking, setIsChecking] = useState(false);
  const [isBrowsingDirectory, setIsBrowsingDirectory] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageTone, setMessageTone] = useState<"error" | "neutral" | "success">("neutral");
  const [preflight, setPreflight] = useState<ProjectSshPreflightResult | null>(null);
  const [remoteDirectoryBrowser, setRemoteDirectoryBrowser] =
    useState<ProjectListDirectoryResult | null>(null);

  useEffect(() => {
    setDraft(draftFromExecutionTarget(props.project.executionTarget));
    setMessage(null);
    setMessageTone("neutral");
    setPreflight(null);
    setRemoteDirectoryBrowser(null);
  }, [props.project.executionTarget]);

  const targetBuild = useMemo(() => buildExecutionTargetFromDraft(draft), [draft]);
  const isDirty =
    targetBuild.ok &&
    !equalExecutionTargets(targetBuild.executionTarget, props.project.executionTarget);

  const updateDraft = useCallback((patch: Partial<ProjectExecutionDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setMessage(null);
    setMessageTone("neutral");
    setPreflight(null);
  }, []);

  const loadSshDirectory = useCallback(
    async (directoryPath?: string) => {
      const nextInput = buildSshDirectoryInputFromDraft({
        ...draft,
        ...(directoryPath !== undefined ? { remotePath: directoryPath } : {}),
      });
      if (!nextInput.ok) {
        setMessage(nextInput.error);
        setMessageTone("error");
        setRemoteDirectoryBrowser(null);
        return;
      }

      setIsBrowsingDirectory(true);
      setMessage(null);
      setMessageTone("neutral");
      try {
        const api = ensureNativeApi();
        const listing = await api.projects.listSshDirectory(nextInput.input);
        setRemoteDirectoryBrowser(listing);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to load SSH directories.");
        setMessageTone("error");
        setRemoteDirectoryBrowser(null);
      } finally {
        setIsBrowsingDirectory(false);
      }
    },
    [draft],
  );

  const createSshDirectory = useCallback(
    async (name: string) => {
      const nextInput = buildSshDirectoryInputFromDraft(draft);
      if (!nextInput.ok) {
        setMessage(nextInput.error);
        setMessageTone("error");
        return;
      }

      setIsBrowsingDirectory(true);
      setMessage(null);
      setMessageTone("neutral");
      try {
        const api = ensureNativeApi();
        const listing = await api.projects.createSshDirectory({
          host: nextInput.input.host,
          ...(nextInput.input.username ? { username: nextInput.input.username } : {}),
          ...(nextInput.input.port !== undefined ? { port: nextInput.input.port } : {}),
          path: remoteDirectoryBrowser?.directoryPath ?? nextInput.input.path,
          name,
        });
        setRemoteDirectoryBrowser(listing);
        setDraft((current) => ({ ...current, remotePath: listing.directoryPath }));
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Unable to create SSH directory.");
        setMessageTone("error");
        throw error;
      } finally {
        setIsBrowsingDirectory(false);
      }
    },
    [draft, remoteDirectoryBrowser?.directoryPath],
  );

  const checkSshTarget = useCallback(async () => {
    if (draft.kind !== "ssh") {
      setPreflight(null);
      setMessage(null);
      return null;
    }

    const nextInput = buildSshPreflightInputFromDraft(draft);
    if (!nextInput.ok) {
      setMessage(nextInput.error);
      setMessageTone("error");
      setPreflight(null);
      return null;
    }

    setIsChecking(true);
    setMessage(null);
    setMessageTone("neutral");
    try {
      const api = ensureNativeApi();
      const result = await api.projects.preflightSshTarget(nextInput.input);
      setPreflight(result);
      if (!draft.localPath.trim()) {
        setDraft((current) => ({ ...current, localPath: result.resolvedLocalPath }));
      }
      setMessage(result.errors.length > 0 ? result.errors.join(" ") : "SSH target is ready.");
      setMessageTone(result.errors.length > 0 ? "error" : "success");
      return result;
    } catch (error) {
      const nextMessage =
        error instanceof Error ? error.message : "Unable to validate execution target.";
      setMessage(nextMessage);
      setMessageTone("error");
      setPreflight(null);
      return null;
    } finally {
      setIsChecking(false);
    }
  }, [draft]);

  const save = useCallback(async () => {
    let nextDraft = draft;
    if (draft.kind === "ssh" && !draft.localPath.trim()) {
      const checked = await checkSshTarget();
      if (!checked) {
        return;
      }
      nextDraft = {
        ...draft,
        localPath: checked.resolvedLocalPath,
      };
    }

    const nextTarget = buildExecutionTargetFromDraft(nextDraft);
    if (!nextTarget.ok) {
      setMessage(nextTarget.error);
      setMessageTone("error");
      return;
    }

    if (equalExecutionTargets(nextTarget.executionTarget, props.project.executionTarget)) {
      setMessage("No changes to save.");
      setMessageTone("neutral");
      return;
    }

    setIsSaving(true);
    setMessage(null);
    setMessageTone("neutral");
    try {
      const api = ensureNativeApi();
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: props.project.id,
        executionTarget: nextTarget.executionTarget,
      });
      setMessage("Saved.");
      setMessageTone("success");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save execution target.");
      setMessageTone("error");
    } finally {
      setIsSaving(false);
    }
  }, [checkSshTarget, draft, props.project.executionTarget, props.project.id]);

  return (
    <div className="rounded-xl border border-border bg-background/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <HardDriveIcon className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">{props.project.name}</h3>
          </div>
          <p className="break-all font-mono text-[11px] text-muted-foreground">
            {props.project.cwd}
          </p>
          <p className="text-xs text-muted-foreground">
            Current target:{" "}
            <span className="font-medium text-foreground">
              {projectExecutionTargetLabel(props.project.executionTarget)}
            </span>
            {" · "}
            {projectExecutionTargetDescription(props.project.executionTarget)}
          </p>
        </div>
        <div className="flex gap-2">
          {draft.kind === "ssh" && (
            <Button
              size="sm"
              variant="outline"
              disabled={isChecking || isSaving}
              onClick={() => void checkSshTarget()}
            >
              {isChecking ? "Checking..." : "Check SSH"}
            </Button>
          )}
          <Button size="sm" disabled={isSaving || !isDirty} onClick={() => void save()}>
            <SaveIcon className="mr-1 size-3.5" />
            {isSaving ? "Saving..." : "Save"}
          </Button>
        </div>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Execution target</label>
          <Select
            value={draft.kind}
            onValueChange={(value) =>
              value && updateDraft({ kind: value as ProjectExecutionDraft["kind"] })
            }
          >
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="workspace-local">
                <div className="flex items-center gap-2">
                  <CpuIcon className="size-3.5 text-muted-foreground" />
                  <span>This server</span>
                </div>
              </SelectItem>
              <SelectItem value="ssh">
                <div className="flex items-center gap-2">
                  <ServerCogIcon className="size-3.5 text-muted-foreground" />
                  <span>SSH + Mutagen</span>
                </div>
              </SelectItem>
            </SelectPopup>
          </Select>
        </div>
      </div>

      {draft.kind === "ssh" && (
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Label</label>
            <Input
              value={draft.label}
              onChange={(event) => updateDraft({ label: event.target.value })}
              placeholder="GPU box"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">SSH host</label>
            <Input
              value={draft.host}
              onChange={(event) => updateDraft({ host: event.target.value })}
              placeholder="gpu-1.internal"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">SSH username</label>
            <Input
              value={draft.username}
              onChange={(event) => updateDraft({ username: event.target.value })}
              placeholder="ubuntu"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">SSH port</label>
            <Input
              value={draft.port}
              onChange={(event) => updateDraft({ port: event.target.value })}
              placeholder="22"
            />
          </div>
          <div className="space-y-1 md:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">Remote project path</label>
            <div className="flex gap-2">
              <Input
                value={draft.remotePath}
                onChange={(event) => updateDraft({ remotePath: event.target.value })}
                placeholder="/srv/projects/my-repo"
              />
              <Button
                type="button"
                variant="outline"
                className="shrink-0"
                disabled={isBrowsingDirectory || isChecking || isSaving}
                onClick={() => void loadSshDirectory()}
              >
                <FolderIcon className="mr-1 size-3.5" />
                {isBrowsingDirectory ? "Loading..." : "Browse"}
              </Button>
            </div>
          </div>
          <div className="space-y-1 md:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">
              Workspace mirror path on this server
            </label>
            <Input
              value={draft.localPath}
              onChange={(event) => updateDraft({ localPath: event.target.value })}
              placeholder="/var/t3code/mirrors/my-repo"
            />
            <p className="text-[11px] text-muted-foreground">
              Mutagen syncs between the workspace host and the SSH target using this local mirror
              path.
            </p>
          </div>
          <div className="space-y-1 md:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">
              Mutagen ignore patterns
            </label>
            <Textarea
              rows={5}
              value={draft.ignoresText}
              onChange={(event) => updateDraft({ ignoresText: event.target.value })}
              placeholder="node_modules&#10;.next&#10;dist"
            />
          </div>
        </div>
      )}

      {draft.kind === "ssh" && preflight && (
        <div className="mt-3 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-[11px] text-muted-foreground">
          <div className="font-medium text-foreground/80">
            Mirror path: {preflight.resolvedLocalPath}
          </div>
          <div className="mt-1">
            SSH {preflight.sshReachable ? "ready" : "blocked"} · remote path{" "}
            {preflight.remotePathExists ? "ready" : "blocked"} · mutagen{" "}
            {preflight.mutagenInstalled ? "ready" : "blocked"} · local mirror{" "}
            {preflight.localPathWritable ? "ready" : "blocked"}
          </div>
          {preflight.errors.length > 0 ? (
            <div className="mt-2 space-y-1 text-destructive">
              {preflight.errors.map((error) => (
                <div key={error}>{error}</div>
              ))}
            </div>
          ) : null}
        </div>
      )}

      {message && (
        <p
          className={`mt-3 text-xs ${
            messageTone === "error"
              ? "text-destructive"
              : messageTone === "success"
                ? "text-emerald-600 dark:text-emerald-400"
                : "text-muted-foreground"
          }`}
        >
          {message}
        </p>
      )}

      {draft.kind === "ssh" && remoteDirectoryBrowser ? (
        <RemoteDirectoryBrowserDialog
          open
          title={`Browse ${draft.host.trim() || "SSH host"}`}
          description="Select a directory on the SSH target and use it as the remote project path."
          listing={remoteDirectoryBrowser}
          isLoading={isBrowsingDirectory}
          onClose={() => setRemoteDirectoryBrowser(null)}
          onNavigate={(path) => void loadSshDirectory(path)}
          onPathSubmit={(path) => loadSshDirectory(path)}
          onCreateDirectory={createSshDirectory}
          onUse={() => {
            updateDraft({ remotePath: remoteDirectoryBrowser.directoryPath });
            setRemoteDirectoryBrowser(null);
          }}
        />
      ) : null}
    </div>
  );
}

export function ProjectExecutionSettingsSection(props: ProjectExecutionSettingsSectionProps) {
  const projects = props.projects.toSorted((left, right) => left.name.localeCompare(right.name));

  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="mb-4">
        <h2 className="text-sm font-medium text-foreground">Project execution</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          Assign each project to either the workspace host or a remote SSH target. This stores the
          execution plan on the workspace server so future thread launches can stay pinned to the
          same host.
        </p>
      </div>

      {projects.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-4 text-sm text-muted-foreground">
          Add a project first. Execution targets are configured per project.
        </div>
      ) : (
        <div className="space-y-3">
          {projects.map((project) => (
            <ProjectExecutionCard key={project.id} project={project} />
          ))}
        </div>
      )}
    </section>
  );
}
