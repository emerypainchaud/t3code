import type { ProjectExecutionTarget } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CpuIcon, HardDriveIcon, SaveIcon, ServerCogIcon } from "lucide-react";

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

function equalExecutionTargets(left: ProjectExecutionTarget, right: ProjectExecutionTarget): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function buildExecutionTargetFromDraft(draft: ProjectExecutionDraft): {
  ok: true;
  executionTarget: ProjectExecutionTarget;
} | {
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

function ProjectExecutionCard(props: { readonly project: Project }) {
  const [draft, setDraft] = useState<ProjectExecutionDraft>(() =>
    draftFromExecutionTarget(props.project.executionTarget),
  );
  const [isSaving, setIsSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    setDraft(draftFromExecutionTarget(props.project.executionTarget));
    setMessage(null);
  }, [props.project.executionTarget]);

  const targetBuild = useMemo(() => buildExecutionTargetFromDraft(draft), [draft]);
  const isDirty =
    targetBuild.ok && !equalExecutionTargets(targetBuild.executionTarget, props.project.executionTarget);

  const updateDraft = useCallback((patch: Partial<ProjectExecutionDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setMessage(null);
  }, []);

  const save = useCallback(async () => {
    const nextTarget = buildExecutionTargetFromDraft(draft);
    if (!nextTarget.ok) {
      setMessage(nextTarget.error);
      return;
    }

    if (equalExecutionTargets(nextTarget.executionTarget, props.project.executionTarget)) {
      setMessage("No changes to save.");
      return;
    }

    setIsSaving(true);
    setMessage(null);
    try {
      const api = ensureNativeApi();
      await api.orchestration.dispatchCommand({
        type: "project.meta.update",
        commandId: newCommandId(),
        projectId: props.project.id,
        executionTarget: nextTarget.executionTarget,
      });
      setMessage("Saved.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to save execution target.");
    } finally {
      setIsSaving(false);
    }
  }, [draft, props.project.executionTarget, props.project.id]);

  return (
    <div className="rounded-xl border border-border bg-background/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <HardDriveIcon className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium text-foreground">{props.project.name}</h3>
          </div>
          <p className="break-all font-mono text-[11px] text-muted-foreground">{props.project.cwd}</p>
          <p className="text-xs text-muted-foreground">
            Current target:{" "}
            <span className="font-medium text-foreground">
              {projectExecutionTargetLabel(props.project.executionTarget)}
            </span>
            {" · "}
            {projectExecutionTargetDescription(props.project.executionTarget)}
          </p>
        </div>
        <Button size="sm" disabled={isSaving || !isDirty} onClick={() => void save()}>
          <SaveIcon className="mr-1 size-3.5" />
          {isSaving ? "Saving..." : "Save"}
        </Button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Execution target</label>
          <Select value={draft.kind} onValueChange={(value) => value && updateDraft({ kind: value as ProjectExecutionDraft["kind"] })}>
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
            <Input
              value={draft.remotePath}
              onChange={(event) => updateDraft({ remotePath: event.target.value })}
              placeholder="/srv/projects/my-repo"
            />
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
              Mutagen syncs between the workspace host and the SSH target using this local mirror path.
            </p>
          </div>
          <div className="space-y-1 md:col-span-2">
            <label className="text-xs font-medium text-muted-foreground">Mutagen ignore patterns</label>
            <Textarea
              rows={5}
              value={draft.ignoresText}
              onChange={(event) => updateDraft({ ignoresText: event.target.value })}
              placeholder="node_modules&#10;.next&#10;dist"
            />
          </div>
        </div>
      )}

      {message && (
        <p className={`mt-3 text-xs ${message === "Saved." ? "text-muted-foreground" : "text-destructive"}`}>
          {message}
        </p>
      )}
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
          execution plan on the workspace server so future thread launches can stay pinned to the same host.
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
