import { Schema } from "effect";
import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas";
import { KeybindingRule, ResolvedKeybindingsConfig } from "./keybindings";
import { EditorId } from "./editor";
import { ProviderKind } from "./orchestration";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = Schema.Array(ServerConfigIssue);

export const ServerProviderStatusState = Schema.Literals(["ready", "warning", "error"]);
export type ServerProviderStatusState = typeof ServerProviderStatusState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderStatus = Schema.Struct({
  provider: ProviderKind,
  status: ServerProviderStatusState,
  available: Schema.Boolean,
  authStatus: ServerProviderAuthStatus,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderStatus = typeof ServerProviderStatus.Type;

const ServerProviderStatuses = Schema.Array(ServerProviderStatus);

export const ServerWorkspaceAccessEndpointScope = Schema.Literals(["local", "lan", "public"]);
export type ServerWorkspaceAccessEndpointScope = typeof ServerWorkspaceAccessEndpointScope.Type;

export const ServerWorkspaceAccessEndpoint = Schema.Struct({
  label: TrimmedNonEmptyString,
  wsUrl: TrimmedNonEmptyString,
  scope: ServerWorkspaceAccessEndpointScope,
});
export type ServerWorkspaceAccessEndpoint = typeof ServerWorkspaceAccessEndpoint.Type;

export const ServerWorkspaceAccessTokenSource = Schema.Literals(["configured", "generated"]);
export type ServerWorkspaceAccessTokenSource = typeof ServerWorkspaceAccessTokenSource.Type;

export const ServerWorkspaceTlsMode = Schema.Literals(["disabled", "self-signed"]);
export type ServerWorkspaceTlsMode = typeof ServerWorkspaceTlsMode.Type;

export const ServerWorkspaceTls = Schema.Struct({
  mode: ServerWorkspaceTlsMode,
  fingerprintSha256: Schema.optional(TrimmedNonEmptyString),
  validFrom: Schema.optional(IsoDateTime),
  validTo: Schema.optional(IsoDateTime),
});
export type ServerWorkspaceTls = typeof ServerWorkspaceTls.Type;

export const ServerWorkspaceAccess = Schema.Struct({
  token: TrimmedNonEmptyString,
  tokenSource: ServerWorkspaceAccessTokenSource,
  loopbackBypassEnabled: Schema.Boolean,
  endpoints: Schema.Array(ServerWorkspaceAccessEndpoint),
  tls: ServerWorkspaceTls,
});
export type ServerWorkspaceAccess = typeof ServerWorkspaceAccess.Type;

export const ServerConfig = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
  availableEditors: Schema.Array(EditorId),
  workspaceAccess: ServerWorkspaceAccess,
});
export type ServerConfig = typeof ServerConfig.Type;

export const ServerUpsertKeybindingInput = KeybindingRule;
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerRotateWorkspaceAccessTokenResult = ServerWorkspaceAccess;
export type ServerRotateWorkspaceAccessTokenResult =
  typeof ServerRotateWorkspaceAccessTokenResult.Type;

export const ServerRotateWorkspaceTlsCertificateResult = ServerWorkspaceAccess;
export type ServerRotateWorkspaceTlsCertificateResult =
  typeof ServerRotateWorkspaceTlsCertificateResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviderStatuses,
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;
