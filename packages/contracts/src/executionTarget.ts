import * as Schema from "effect/Schema";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ProjectExecutionSyncMode = Schema.Literal("mutagen");
export type ProjectExecutionSyncMode = typeof ProjectExecutionSyncMode.Type;

export const ProjectExecutionSync = Schema.Struct({
  mode: ProjectExecutionSyncMode,
  localPath: TrimmedNonEmptyString,
  ignores: Schema.Array(TrimmedNonEmptyString),
});
export type ProjectExecutionSync = typeof ProjectExecutionSync.Type;

export const WorkspaceLocalExecutionTarget = Schema.Struct({
  kind: Schema.Literal("workspace-local"),
});
export type WorkspaceLocalExecutionTarget = typeof WorkspaceLocalExecutionTarget.Type;

export const SshExecutionTarget = Schema.Struct({
  kind: Schema.Literal("ssh"),
  label: Schema.optional(TrimmedNonEmptyString),
  host: TrimmedNonEmptyString,
  port: Schema.optional(PositiveInt),
  username: Schema.optional(TrimmedNonEmptyString),
  remotePath: TrimmedNonEmptyString,
  sync: ProjectExecutionSync,
});
export type SshExecutionTarget = typeof SshExecutionTarget.Type;

export const ProjectExecutionTarget = Schema.Union([
  WorkspaceLocalExecutionTarget,
  SshExecutionTarget,
]);
export type ProjectExecutionTarget = typeof ProjectExecutionTarget.Type;
