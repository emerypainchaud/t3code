import { Schema } from "effect";
import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas";

const PROJECT_SEARCH_ENTRIES_MAX_LIMIT = 200;
const PROJECT_LIST_DIRECTORY_MAX_ENTRIES = 500;
const PROJECT_WRITE_FILE_PATH_MAX_LENGTH = 512;

export const ProjectSearchEntriesInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  query: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_SEARCH_ENTRIES_MAX_LIMIT)),
});
export type ProjectSearchEntriesInput = typeof ProjectSearchEntriesInput.Type;

const ProjectEntryKind = Schema.Literals(["file", "directory"]);

export const ProjectEntry = Schema.Struct({
  path: TrimmedNonEmptyString,
  kind: ProjectEntryKind,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectEntry = typeof ProjectEntry.Type;

export const ProjectSearchEntriesResult = Schema.Struct({
  entries: Schema.Array(ProjectEntry),
  truncated: Schema.Boolean,
});
export type ProjectSearchEntriesResult = typeof ProjectSearchEntriesResult.Type;

export const ProjectListDirectoryInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_LIST_DIRECTORY_MAX_ENTRIES)).pipe(
    Schema.withDecodingDefault(() => PROJECT_LIST_DIRECTORY_MAX_ENTRIES),
  ),
});
export type ProjectListDirectoryInput = typeof ProjectListDirectoryInput.Type;

export const ProjectDirectoryEntry = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  parentPath: Schema.optional(TrimmedNonEmptyString),
});
export type ProjectDirectoryEntry = typeof ProjectDirectoryEntry.Type;

export const ProjectListDirectoryResult = Schema.Struct({
  directoryPath: TrimmedNonEmptyString,
  parentPath: Schema.NullOr(TrimmedNonEmptyString),
  entries: Schema.Array(ProjectDirectoryEntry),
  truncated: Schema.Boolean,
});
export type ProjectListDirectoryResult = typeof ProjectListDirectoryResult.Type;

const ProjectDirectoryName = TrimmedNonEmptyString.check(Schema.isPattern(/^(?!\.{1,2}$)[^/\\]+$/));

export const ProjectCreateDirectoryInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  name: ProjectDirectoryName,
});
export type ProjectCreateDirectoryInput = typeof ProjectCreateDirectoryInput.Type;

export const ProjectSshConnectionInput = Schema.Struct({
  host: TrimmedNonEmptyString,
  username: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(PositiveInt),
});
export type ProjectSshConnectionInput = typeof ProjectSshConnectionInput.Type;

export const ProjectSshDirectoryListInput = Schema.Struct({
  host: TrimmedNonEmptyString,
  username: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(PositiveInt),
  path: TrimmedNonEmptyString,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(PROJECT_LIST_DIRECTORY_MAX_ENTRIES)).pipe(
    Schema.withDecodingDefault(() => PROJECT_LIST_DIRECTORY_MAX_ENTRIES),
  ),
});
export type ProjectSshDirectoryListInput = typeof ProjectSshDirectoryListInput.Type;

export const ProjectSshCreateDirectoryInput = Schema.Struct({
  host: TrimmedNonEmptyString,
  username: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(PositiveInt),
  path: TrimmedNonEmptyString,
  name: ProjectDirectoryName,
});
export type ProjectSshCreateDirectoryInput = typeof ProjectSshCreateDirectoryInput.Type;

export const ProjectSshPreflightInput = Schema.Struct({
  host: TrimmedNonEmptyString,
  username: Schema.optional(TrimmedNonEmptyString),
  port: Schema.optional(PositiveInt),
  remotePath: TrimmedNonEmptyString,
  localPathOverride: Schema.optional(TrimmedNonEmptyString),
  ignores: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(() => [])),
});
export type ProjectSshPreflightInput = typeof ProjectSshPreflightInput.Type;

export const ProjectSshPreflightResult = Schema.Struct({
  suggestedLocalPath: TrimmedNonEmptyString,
  resolvedLocalPath: TrimmedNonEmptyString,
  sshReachable: Schema.Boolean,
  remotePathExists: Schema.Boolean,
  mutagenInstalled: Schema.Boolean,
  localPathWritable: Schema.Boolean,
  remoteShellReady: Schema.Boolean,
  errors: Schema.Array(TrimmedNonEmptyString),
});
export type ProjectSshPreflightResult = typeof ProjectSshPreflightResult.Type;

export const ProjectWriteFileInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  relativePath: TrimmedNonEmptyString.check(Schema.isMaxLength(PROJECT_WRITE_FILE_PATH_MAX_LENGTH)),
  contents: Schema.String,
});
export type ProjectWriteFileInput = typeof ProjectWriteFileInput.Type;

export const ProjectWriteFileResult = Schema.Struct({
  relativePath: TrimmedNonEmptyString,
});
export type ProjectWriteFileResult = typeof ProjectWriteFileResult.Type;
