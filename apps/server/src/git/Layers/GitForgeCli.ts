import fs from "node:fs";

import type { GitForge } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { runProcess } from "../../processRunner";
import { GitForgeCliError } from "../Errors.ts";
import {
  GitForgeCli,
  type GitForgeCliShape,
  type GitReviewRequestSummary,
} from "../Services/GitForgeCli.ts";

const DEFAULT_TIMEOUT_MS = 30_000;
const FORGE_CACHE_TTL_MS = 60_000;

interface CachedForgeEntry {
  readonly forge: GitForge | null;
  readonly remoteUrl: string | null;
  readonly expiresAt: number;
}

interface ForgeClient {
  readonly forge: GitForge;
  readonly command: "gh" | "glab";
  readonly execute: GitForgeCliShape["execute"];
  readonly probeRepository: (cwd: string) => Effect.Effect<boolean, GitForgeCliError>;
  readonly listReviewRequests: (input: {
    readonly cwd: string;
    readonly headBranch: string;
    readonly state: "open" | "all";
    readonly limit: number;
  }) => Effect.Effect<ReadonlyArray<GitReviewRequestSummary>, GitForgeCliError>;
  readonly createReviewRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<GitForge, GitForgeCliError>;
  readonly getDefaultBranch: (cwd: string) => Effect.Effect<string | null, GitForgeCliError>;
}

function normalizeForgeCliError(
  forge: GitForge,
  command: "gh" | "glab",
  operation: string,
  error: unknown,
): GitForgeCliError {
  if (error instanceof Error) {
    if (error.message.includes(`Command not found: ${command}`)) {
      const cliLabel = command === "gh" ? "GitHub CLI (`gh`)" : "GitLab CLI (`glab`)";
      return new GitForgeCliError({
        operation,
        detail: `${cliLabel} is required but not available on PATH.`,
        cause: error,
      });
    }

    const lower = error.message.toLowerCase();
    if (
      lower.includes("authentication failed") ||
      lower.includes("not logged in") ||
      lower.includes("auth login") ||
      lower.includes("no oauth token") ||
      lower.includes("401") ||
      lower.includes("403")
    ) {
      const loginCommand = command === "gh" ? "`gh auth login`" : "`glab auth login`";
      const forgeLabel = forge === "github" ? "GitHub" : "GitLab";
      return new GitForgeCliError({
        operation,
        detail: `${forgeLabel} CLI is not authenticated. Run ${loginCommand} and retry.`,
        cause: error,
      });
    }

    const forgeLabel = forge === "github" ? "GitHub" : "GitLab";
    return new GitForgeCliError({
      operation,
      detail: `${forgeLabel} CLI command failed: ${error.message}`,
      cause: error,
    });
  }

  return new GitForgeCliError({
    operation,
    detail: `${forge === "github" ? "GitHub" : "GitLab"} CLI command failed.`,
    cause: error,
  });
}

function parseForgeFromRemoteUrl(remoteUrl: string | null): GitForge | null {
  if (!remoteUrl) return null;
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) return null;

  const tryParseHost = (): string | null => {
    if (
      trimmed.startsWith("http://") ||
      trimmed.startsWith("https://") ||
      trimmed.startsWith("ssh://") ||
      trimmed.startsWith("git://")
    ) {
      try {
        return new URL(trimmed).hostname.toLowerCase();
      } catch {
        return null;
      }
    }

    const scpLike = /^(?:[^@]+@)?([^:/]+)[:/].+$/u.exec(trimmed);
    return scpLike?.[1]?.toLowerCase() ?? null;
  };

  const host = tryParseHost();
  if (!host) return null;
  if (host.includes("github")) return "github";
  if (host.includes("gitlab")) return "gitlab";
  return null;
}

function parseGitHubReviewRequests(raw: string): ReadonlyArray<GitReviewRequestSummary> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("GitHub CLI returned non-array JSON.");
  }

  const result: GitReviewRequestSummary[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = record.number;
    const title = record.title;
    const url = record.url;
    const baseRefName = record.baseRefName;
    const headRefName = record.headRefName;
    const state = record.state;
    const mergedAt = record.mergedAt;
    const updatedAt = record.updatedAt;
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number <= 0 ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof baseRefName !== "string" ||
      typeof headRefName !== "string"
    ) {
      continue;
    }

    let normalizedState: GitReviewRequestSummary["state"];
    if ((typeof mergedAt === "string" && mergedAt.trim().length > 0) || state === "MERGED") {
      normalizedState = "merged";
    } else if (state === "CLOSED") {
      normalizedState = "closed";
    } else {
      normalizedState = "open";
    }

    result.push({
      forge: "github",
      number,
      title,
      url,
      baseRefName,
      headRefName,
      state: normalizedState,
      updatedAt: typeof updatedAt === "string" && updatedAt.trim().length > 0 ? updatedAt : null,
    });
  }

  return result;
}

function parseGitLabReviewRequests(raw: string): ReadonlyArray<GitReviewRequestSummary> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];

  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error("GitLab CLI returned non-array JSON.");
  }

  const result: GitReviewRequestSummary[] = [];
  for (const entry of parsed) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const number = record.iid;
    const title = record.title;
    const url = record.web_url;
    const baseRefName = record.target_branch;
    const headRefName = record.source_branch;
    const state = record.state;
    const mergedAt = record.merged_at;
    const updatedAt = record.updated_at;
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      number <= 0 ||
      typeof title !== "string" ||
      typeof url !== "string" ||
      typeof baseRefName !== "string" ||
      typeof headRefName !== "string" ||
      typeof state !== "string"
    ) {
      continue;
    }

    const normalizedState =
      typeof mergedAt === "string" && mergedAt.trim().length > 0
        ? "merged"
        : state === "merged"
          ? "merged"
          : state === "closed"
            ? "closed"
            : "open";

    result.push({
      forge: "gitlab",
      number,
      title,
      url,
      baseRefName,
      headRefName,
      state: normalizedState,
      updatedAt: typeof updatedAt === "string" && updatedAt.trim().length > 0 ? updatedAt : null,
    });
  }

  return result;
}

function parseGitLabDefaultBranch(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  const parsed: unknown = JSON.parse(trimmed);
  if (!parsed || typeof parsed !== "object") return null;
  const defaultBranch = (parsed as Record<string, unknown>).default_branch;
  return typeof defaultBranch === "string" && defaultBranch.trim().length > 0
    ? defaultBranch.trim()
    : null;
}

export const makeGitForgeCli = Effect.sync(() => {
  const forgeCache = new Map<string, CachedForgeEntry>();

  const executeCommand = (
    forge: GitForge,
    command: "gh" | "glab",
    input: {
      readonly cwd: string;
      readonly args: ReadonlyArray<string>;
      readonly timeoutMs?: number;
      readonly stdin?: string;
    },
  ) =>
    Effect.tryPromise({
      try: () =>
        runProcess(command, input.args, {
          cwd: input.cwd,
          timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
          ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
        }),
      catch: (error) => normalizeForgeCliError(forge, command, `${forge}.execute`, error),
    });

  const execute: GitForgeCliShape["execute"] = (input) =>
    executeCommand(input.forge, input.forge === "github" ? "gh" : "glab", input);

  const gitHubClient: ForgeClient = {
    forge: "github",
    command: "gh",
    execute,
    probeRepository: (cwd) =>
      execute({ forge: "github", cwd, args: ["repo", "view", "--json", "nameWithOwner"] }).pipe(
        Effect.as(true),
      ),
    listReviewRequests: (input) =>
      execute({
        forge: "github",
        cwd: input.cwd,
        args: [
          "pr",
          "list",
          "--head",
          input.headBranch,
          "--state",
          input.state,
          "--limit",
          String(input.limit),
          "--json",
          "number,title,url,baseRefName,headRefName,state,mergedAt,updatedAt",
        ],
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseGitHubReviewRequests(raw),
            catch: (error) =>
              new GitForgeCliError({
                operation: "github.listReviewRequests",
                detail:
                  error instanceof Error
                    ? `GitHub CLI returned invalid PR list JSON: ${error.message}`
                    : "GitHub CLI returned invalid PR list JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      ),
    createReviewRequest: (input) =>
      execute({
        forge: "github",
        cwd: input.cwd,
        args: [
          "pr",
          "create",
          "--base",
          input.baseBranch,
          "--head",
          input.headBranch,
          "--title",
          input.title,
          "--body-file",
          input.bodyFile,
        ],
      }).pipe(Effect.as("github" as const)),
    getDefaultBranch: (cwd) =>
      execute({
        forge: "github",
        cwd,
        args: ["repo", "view", "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      }).pipe(
        Effect.map((result) => {
          const trimmed = result.stdout.trim();
          return trimmed.length > 0 ? trimmed : null;
        }),
      ),
  };

  const gitLabClient: ForgeClient = {
    forge: "gitlab",
    command: "glab",
    execute,
    probeRepository: (cwd) =>
      execute({ forge: "gitlab", cwd, args: ["api", "projects/:id"] }).pipe(Effect.as(true)),
    listReviewRequests: (input) =>
      execute({
        forge: "gitlab",
        cwd: input.cwd,
        args: [
          "api",
          `projects/:id/merge_requests?source_branch=${encodeURIComponent(input.headBranch)}&state=${
            input.state === "open" ? "opened" : "all"
          }&per_page=${input.limit}`,
        ],
      }).pipe(
        Effect.map((result) => result.stdout),
        Effect.flatMap((raw) =>
          Effect.try({
            try: () => parseGitLabReviewRequests(raw),
            catch: (error) =>
              new GitForgeCliError({
                operation: "gitlab.listReviewRequests",
                detail:
                  error instanceof Error
                    ? `GitLab CLI returned invalid merge request JSON: ${error.message}`
                    : "GitLab CLI returned invalid merge request JSON.",
                ...(error !== undefined ? { cause: error } : {}),
              }),
          }),
        ),
      ),
    createReviewRequest: (input) =>
      Effect.gen(function* () {
        const body = yield* Effect.try({
          try: () => fs.readFileSync(input.bodyFile, "utf8"),
          catch: (error) =>
            new GitForgeCliError({
              operation: "gitlab.createReviewRequest",
              detail: "Failed to read merge request body temp file.",
              ...(error !== undefined ? { cause: error } : {}),
            }),
        });

        return yield* execute({
          forge: "gitlab",
          cwd: input.cwd,
          args: [
            "api",
            "projects/:id/merge_requests",
            "--method",
            "POST",
            "--header",
            "Content-Type: application/json",
            "--input",
            "-",
          ],
          stdin: JSON.stringify({
            source_branch: input.headBranch,
            target_branch: input.baseBranch,
            title: input.title,
            description: body,
          }),
        }).pipe(Effect.as("gitlab" as const));
      }),
    getDefaultBranch: (cwd) =>
      execute({ forge: "gitlab", cwd, args: ["api", "projects/:id"] }).pipe(
        Effect.map((result) => parseGitLabDefaultBranch(result.stdout)),
      ),
  };

  const forgeClients: Record<GitForge, ForgeClient> = {
    github: gitHubClient,
    gitlab: gitLabClient,
  };

  const readRemoteUrl = (cwd: string) =>
    Effect.promise(async () => {
      try {
        const result = await runProcess("git", ["config", "--get", "remote.origin.url"], {
          cwd,
          timeoutMs: 10_000,
          allowNonZeroExit: true,
        });
        if (result.code !== 0) return null;
        const trimmed = result.stdout.trim();
        return trimmed.length > 0 ? trimmed : null;
      } catch {
        return null;
      }
    });

  const probeForge = (client: ForgeClient, cwd: string) =>
    client.probeRepository(cwd).pipe(Effect.catch(() => Effect.succeed(false)));

  const resolveForge: GitForgeCliShape["resolveForge"] = ({ cwd }) =>
    Effect.gen(function* () {
      const remoteUrl = yield* readRemoteUrl(cwd);
      const cacheKey = `${cwd}`;
      const cached = forgeCache.get(cacheKey);
      if (
        cached &&
        cached.remoteUrl === remoteUrl &&
        cached.expiresAt > Date.now()
      ) {
        return cached.forge;
      }

      const inferred = parseForgeFromRemoteUrl(remoteUrl);
      if (inferred) {
        forgeCache.set(cacheKey, {
          forge: inferred,
          remoteUrl,
          expiresAt: Date.now() + FORGE_CACHE_TTL_MS,
        });
        return inferred;
      }

      const githubDetected = yield* probeForge(gitHubClient, cwd);
      if (githubDetected) {
        forgeCache.set(cacheKey, {
          forge: "github",
          remoteUrl,
          expiresAt: Date.now() + FORGE_CACHE_TTL_MS,
        });
        return "github";
      }

      const gitlabDetected = yield* probeForge(gitLabClient, cwd);
      const resolved = gitlabDetected ? "gitlab" : null;
      forgeCache.set(cacheKey, {
        forge: resolved,
        remoteUrl,
        expiresAt: Date.now() + FORGE_CACHE_TTL_MS,
      });
      return resolved;
    });

  const withResolvedClient = <A>(
    cwd: string,
    operation: string,
    run: (client: ForgeClient) => Effect.Effect<A, GitForgeCliError>,
  ): Effect.Effect<A, GitForgeCliError> =>
    Effect.gen(function* () {
      const forge = yield* resolveForge({ cwd });
      if (forge) {
        return yield* run(forgeClients[forge]);
      }

      const githubAttempt = yield* Effect.result(run(gitHubClient));
      if (githubAttempt._tag === "Success") {
        return githubAttempt.success;
      }

      const gitlabAttempt = yield* Effect.result(run(gitLabClient));
      if (gitlabAttempt._tag === "Success") {
        return gitlabAttempt.success;
      }

      return yield* new GitForgeCliError({
        operation,
        detail:
          gitlabAttempt.failure.message !== githubAttempt.failure.message
            ? `${githubAttempt.failure.message}; ${gitlabAttempt.failure.message}`
            : githubAttempt.failure.message,
        cause: gitlabAttempt.failure,
      });
    });

  return {
    resolveForge,
    execute,
    listReviewRequests: (input) =>
      withResolvedClient(input.cwd, "listReviewRequests", (client) =>
        client.listReviewRequests({
          cwd: input.cwd,
          headBranch: input.headBranch,
          state: input.state,
          limit: input.limit ?? 20,
        }),
      ),
    createReviewRequest: (input) =>
      withResolvedClient(input.cwd, "createReviewRequest", (client) =>
        client.createReviewRequest(input),
      ),
    getDefaultBranch: (input) =>
      withResolvedClient(input.cwd, "getDefaultBranch", (client) =>
        client.getDefaultBranch(input.cwd),
      ),
  } satisfies GitForgeCliShape;
});

export const GitForgeCliLive = Layer.effect(GitForgeCli, makeGitForgeCli);
