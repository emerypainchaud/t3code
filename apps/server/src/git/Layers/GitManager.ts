import { randomUUID } from "node:crypto";

import { Effect, FileSystem, Layer, Path } from "effect";
import type { GitForge } from "@t3tools/contracts";
import { resolveAutoFeatureBranchName, sanitizeFeatureBranchName } from "@t3tools/shared/git";

import { GitManagerError } from "../Errors.ts";
import { GitManager, type GitManagerShape } from "../Services/GitManager.ts";
import { GitCore } from "../Services/GitCore.ts";
import { GitForgeCli, type GitReviewRequestSummary } from "../Services/GitForgeCli.ts";
import { TextGeneration } from "../Services/TextGeneration.ts";

function gitManagerError(operation: string, detail: string, cause?: unknown): GitManagerError {
  return new GitManagerError({
    operation,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });
}

function limitContext(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n\n[truncated]`;
}

function sanitizeCommitMessage(generated: {
  subject: string;
  body: string;
  branch?: string | undefined;
}): {
  subject: string;
  body: string;
  branch?: string | undefined;
} {
  const rawSubject = generated.subject.trim().split(/\r?\n/g)[0]?.trim() ?? "";
  const subject = rawSubject.replace(/[.]+$/g, "").trim();
  const safeSubject = subject.length > 0 ? subject.slice(0, 72).trimEnd() : "Update project files";
  return {
    subject: safeSubject,
    body: generated.body.trim(),
    ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
  };
}

interface CommitAndBranchSuggestion {
  subject: string;
  body: string;
  branch?: string | undefined;
  commitMessage: string;
}

function formatCommitMessage(subject: string, body: string): string {
  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return subject;
  }
  return `${subject}\n\n${trimmedBody}`;
}

function parseCustomCommitMessage(raw: string): { subject: string; body: string } | null {
  const normalized = raw.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) {
    return null;
  }

  const [firstLine, ...rest] = normalized.split("\n");
  const subject = firstLine?.trim() ?? "";
  if (subject.length === 0) {
    return null;
  }

  return {
    subject,
    body: rest.join("\n").trim(),
  };
}

function extractBranchFromRef(ref: string): string {
  const normalized = ref.trim();

  if (normalized.startsWith("refs/remotes/")) {
    const withoutPrefix = normalized.slice("refs/remotes/".length);
    const firstSlash = withoutPrefix.indexOf("/");
    if (firstSlash === -1) {
      return withoutPrefix.trim();
    }
    return withoutPrefix.slice(firstSlash + 1).trim();
  }

  const firstSlash = normalized.indexOf("/");
  if (firstSlash === -1) {
    return normalized;
  }
  return normalized.slice(firstSlash + 1).trim();
}

function toStatusPr(pr: GitReviewRequestSummary): {
  forge: GitForge;
  number: number;
  title: string;
  url: string;
  baseBranch: string;
  headBranch: string;
  state: "open" | "closed" | "merged";
} {
  return {
    forge: pr.forge,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    baseBranch: pr.baseRefName,
    headBranch: pr.headRefName,
    state: pr.state,
  };
}

interface ResolvedPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseBranch: string;
  readonly headBranch: string;
  readonly state: "open" | "closed" | "merged";
}

function normalizePullRequestReference(reference: string): string {
  return reference.trim();
}

function normalizePullRequestState(value: unknown): "open" | "closed" | "merged" | null {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (normalized === "open" || normalized === "opened") return "open";
  if (normalized === "closed") return "closed";
  if (normalized === "merged") return "merged";
  return null;
}

function parseResolvedPullRequest(raw: unknown): ResolvedPullRequest {
  if (!raw || typeof raw !== "object") {
    throw new Error("Pull request response is not an object.");
  }

  const record = raw as Record<string, unknown>;
  const number =
    typeof record.number === "number"
      ? record.number
      : typeof record.iid === "number"
        ? record.iid
        : null;
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const url =
    typeof record.url === "string"
      ? record.url.trim()
      : typeof record.web_url === "string"
        ? record.web_url.trim()
        : "";
  const baseBranch =
    typeof record.baseRefName === "string"
      ? record.baseRefName.trim()
      : typeof record.target_branch === "string"
        ? record.target_branch.trim()
        : "";
  const headBranch =
    typeof record.headRefName === "string"
      ? record.headRefName.trim()
      : typeof record.source_branch === "string"
        ? record.source_branch.trim()
        : "";
  const state = normalizePullRequestState(record.state);

  if (
    number === null ||
    !Number.isInteger(number) ||
    number <= 0 ||
    title.length === 0 ||
    url.length === 0 ||
    baseBranch.length === 0 ||
    headBranch.length === 0 ||
    state === null
  ) {
    throw new Error("Pull request response is missing required fields.");
  }

  return {
    number,
    title,
    url,
    baseBranch,
    headBranch,
    state,
  };
}

export const makeGitManager = Effect.gen(function* () {
  const gitCore = yield* GitCore;
  const gitForgeCli = yield* GitForgeCli;
  const textGeneration = yield* TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const tempDir = process.env.TMPDIR ?? process.env.TEMP ?? process.env.TMP ?? "/tmp";

  const findOpenPr = (cwd: string, branch: string) =>
    gitForgeCli
      .listReviewRequests({
        cwd,
        headBranch: branch,
        state: "open",
        limit: 1,
      })
      .pipe(
        Effect.map((prs) => {
          const [first] = prs;
          if (!first) {
            return null;
          }
          return first;
        }),
      );

  const findLatestPr = (cwd: string, branch: string) =>
    gitForgeCli
      .listReviewRequests({
        cwd,
        headBranch: branch,
        state: "all",
        limit: 20,
      })
      .pipe(
        Effect.map((prs) => {
          const parsed = [...prs].toSorted((a, b) => {
            const left = a.updatedAt ? Date.parse(a.updatedAt) : 0;
            const right = b.updatedAt ? Date.parse(b.updatedAt) : 0;
            return right - left;
          });

          const latestOpenPr = parsed.find((pr) => pr.state === "open");
          if (latestOpenPr) {
            return latestOpenPr;
          }
          return parsed[0] ?? null;
        }),
      );

  const resolveBaseBranch = (cwd: string, branch: string, upstreamRef: string | null) =>
    Effect.gen(function* () {
      const configured = yield* gitCore.readConfigValue(cwd, `branch.${branch}.gh-merge-base`);
      if (configured) return configured;

      if (upstreamRef) {
        const upstreamBranch = extractBranchFromRef(upstreamRef);
        if (upstreamBranch.length > 0 && upstreamBranch !== branch) {
          return upstreamBranch;
        }
      }

      const defaultFromForge = yield* gitForgeCli
        .getDefaultBranch({ cwd })
        .pipe(Effect.catch(() => Effect.succeed(null)));
      if (defaultFromForge) {
        return defaultFromForge;
      }

      return "main";
    });

  const resolveCommitAndBranchSuggestion = (input: {
    cwd: string;
    branch: string | null;
    commitMessage?: string;
    /** When true, also produce a semantic feature branch name. */
    includeBranch?: boolean;
  }) =>
    Effect.gen(function* () {
      const context = yield* gitCore.prepareCommitContext(input.cwd);
      if (!context) {
        return null;
      }

      const customCommit = parseCustomCommitMessage(input.commitMessage ?? "");
      if (customCommit) {
        return {
          subject: customCommit.subject,
          body: customCommit.body,
          ...(input.includeBranch
            ? { branch: sanitizeFeatureBranchName(customCommit.subject) }
            : {}),
          commitMessage: formatCommitMessage(customCommit.subject, customCommit.body),
        };
      }

      const generated = yield* textGeneration
        .generateCommitMessage({
          cwd: input.cwd,
          branch: input.branch,
          stagedSummary: limitContext(context.stagedSummary, 8_000),
          stagedPatch: limitContext(context.stagedPatch, 50_000),
          ...(input.includeBranch ? { includeBranch: true } : {}),
        })
        .pipe(Effect.map((result) => sanitizeCommitMessage(result)));

      return {
        subject: generated.subject,
        body: generated.body,
        ...(generated.branch !== undefined ? { branch: generated.branch } : {}),
        commitMessage: formatCommitMessage(generated.subject, generated.body),
      };
    });

  const runCommitStep = (
    cwd: string,
    branch: string | null,
    commitMessage?: string,
    preResolvedSuggestion?: CommitAndBranchSuggestion,
  ) =>
    Effect.gen(function* () {
      const suggestion =
        preResolvedSuggestion ??
        (yield* resolveCommitAndBranchSuggestion({
          cwd,
          branch,
          ...(commitMessage ? { commitMessage } : {}),
        }));
      if (!suggestion) {
        return { status: "skipped_no_changes" as const };
      }

      const { commitSha } = yield* gitCore.commit(cwd, suggestion.subject, suggestion.body);
      return {
        status: "created" as const,
        commitSha,
        subject: suggestion.subject,
      };
    });

  const runPrStep = (cwd: string, fallbackBranch: string | null) =>
    Effect.gen(function* () {
      const details = yield* gitCore.statusDetails(cwd);
      const branch = details.branch ?? fallbackBranch;
      if (!branch) {
        return yield* gitManagerError(
          "runPrStep",
          "Cannot create a review request from detached HEAD.",
        );
      }
      if (!details.hasUpstream) {
        return yield* gitManagerError(
          "runPrStep",
          "Current branch has not been pushed. Push before creating a review request.",
        );
      }

      const existing = yield* findOpenPr(cwd, branch);
      if (existing) {
        return {
          status: "opened_existing" as const,
          forge: existing.forge,
          url: existing.url,
          number: existing.number,
          baseBranch: existing.baseRefName,
          headBranch: existing.headRefName,
          title: existing.title,
        };
      }

      const baseBranch = yield* resolveBaseBranch(cwd, branch, details.upstreamRef);
      const rangeContext = yield* gitCore.readRangeContext(cwd, baseBranch);

      const generated = yield* textGeneration.generatePrContent({
        cwd,
        baseBranch,
        headBranch: branch,
        commitSummary: limitContext(rangeContext.commitSummary, 20_000),
        diffSummary: limitContext(rangeContext.diffSummary, 20_000),
        diffPatch: limitContext(rangeContext.diffPatch, 60_000),
      });

      const bodyFile = path.join(tempDir, `t3code-pr-body-${process.pid}-${randomUUID()}.md`);
      yield* fileSystem
        .writeFileString(bodyFile, generated.body)
        .pipe(
          Effect.mapError((cause) =>
            gitManagerError("runPrStep", "Failed to write review request body temp file.", cause),
          ),
        );
      const createdForge = yield* gitForgeCli
        .createReviewRequest({
          cwd,
          baseBranch,
          headBranch: branch,
          title: generated.title,
          bodyFile,
        })
        .pipe(Effect.ensuring(fileSystem.remove(bodyFile).pipe(Effect.catch(() => Effect.void))));

      const created = yield* findOpenPr(cwd, branch);
      if (!created) {
        return {
          status: "created" as const,
          forge: createdForge,
          baseBranch,
          headBranch: branch,
          title: generated.title,
        };
      }

      return {
        status: "created" as const,
        forge: created.forge,
        url: created.url,
        number: created.number,
        baseBranch: created.baseRefName,
        headBranch: created.headRefName,
        title: created.title,
      };
    });

  const resolvePullRequestSummary = (cwd: string, reference: string) =>
    Effect.gen(function* () {
      const forge = yield* gitForgeCli.resolveForge({ cwd });
      if (!forge) {
        return yield* gitManagerError(
          "resolvePullRequest",
          "No supported Git forge is configured for this repository.",
        );
      }

      const result = yield* gitForgeCli.execute({
        forge,
        cwd,
        args:
          forge === "github"
            ? [
                "pr",
                "view",
                reference,
                "--json",
                "number,title,url,baseRefName,headRefName,state",
              ]
            : ["mr", "view", reference, "--output", "json"],
      });

      return yield* Effect.try({
        try: () => parseResolvedPullRequest(JSON.parse(result.stdout)),
        catch: (cause) =>
          gitManagerError(
            "resolvePullRequest",
            "Failed to parse review request metadata from the forge CLI.",
            cause,
          ),
      });
    });

  const status: GitManagerShape["status"] = Effect.fnUntraced(function* (input) {
    const details = yield* gitCore.statusDetails(input.cwd);
    const forge = yield* gitForgeCli.resolveForge({ cwd: input.cwd });

    const pr =
      details.branch !== null
        ? yield* findLatestPr(input.cwd, details.branch).pipe(
            Effect.map((latest) => (latest ? toStatusPr(latest) : null)),
            Effect.catch(() => Effect.succeed(null)),
          )
        : null;

    return {
      branch: details.branch,
      hasWorkingTreeChanges: details.hasWorkingTreeChanges,
      workingTree: details.workingTree,
      forge,
      hasUpstream: details.hasUpstream,
      aheadCount: details.aheadCount,
      behindCount: details.behindCount,
      pr,
    };
  });

  const resolvePullRequest: GitManagerShape["resolvePullRequest"] = Effect.fnUntraced(
    function* (input) {
      const pullRequest = yield* resolvePullRequestSummary(
        input.cwd,
        normalizePullRequestReference(input.reference),
      );
      return { pullRequest };
    },
  );

  const preparePullRequestThread: GitManagerShape["preparePullRequestThread"] = Effect.fnUntraced(
    function* (input) {
      const pullRequest = yield* resolvePullRequestSummary(
        input.cwd,
        normalizePullRequestReference(input.reference),
      );
      const forge = yield* gitForgeCli.resolveForge({ cwd: input.cwd });
      if (!forge) {
        return yield* gitManagerError(
          "preparePullRequestThread",
          "No supported Git forge is configured for this repository.",
        );
      }

      const materializeBranch =
        forge === "github"
          ? gitCore.fetchPullRequestBranch({
              cwd: input.cwd,
              prNumber: pullRequest.number,
              branch: pullRequest.headBranch,
            })
          : gitCore.fetchRemoteBranch({
              cwd: input.cwd,
              remoteName: "origin",
              remoteBranch: pullRequest.headBranch,
              localBranch: pullRequest.headBranch,
            });

      if (input.mode === "local") {
        yield* materializeBranch;
        yield* Effect.scoped(
          gitCore.checkoutBranch({
            cwd: input.cwd,
            branch: pullRequest.headBranch,
          }),
        );
        const details = yield* gitCore.statusDetails(input.cwd);
        return {
          pullRequest,
          branch: details.branch ?? pullRequest.headBranch,
          worktreePath: null,
        };
      }

      const existingBranch = yield* gitCore.listBranches({ cwd: input.cwd }).pipe(
        Effect.map((result) =>
          result.branches.find(
            (branch) =>
              !branch.isRemote &&
              branch.name === pullRequest.headBranch &&
              branch.worktreePath !== null,
          ) ?? null,
        ),
      );
      if (existingBranch?.worktreePath) {
        return {
          pullRequest,
          branch: existingBranch.name,
          worktreePath: existingBranch.worktreePath,
        };
      }

      yield* materializeBranch;
      const worktree = yield* gitCore.createWorktree({
        cwd: input.cwd,
        branch: pullRequest.headBranch,
        path: null,
      });
      return {
        pullRequest,
        branch: worktree.worktree.branch,
        worktreePath: worktree.worktree.path,
      };
    },
  );

  const runFeatureBranchStep = (cwd: string, branch: string | null, commitMessage?: string) =>
    Effect.gen(function* () {
      const suggestion = yield* resolveCommitAndBranchSuggestion({
        cwd,
        branch,
        ...(commitMessage ? { commitMessage } : {}),
        includeBranch: true,
      });
      if (!suggestion) {
        return yield* gitManagerError(
          "runFeatureBranchStep",
          "Cannot create a feature branch because there are no changes to commit.",
        );
      }

      const preferredBranch = suggestion.branch ?? sanitizeFeatureBranchName(suggestion.subject);
      const existingBranchNames = yield* gitCore.listLocalBranchNames(cwd);
      const resolvedBranch = resolveAutoFeatureBranchName(existingBranchNames, preferredBranch);

      yield* gitCore.createBranch({ cwd, branch: resolvedBranch });
      yield* Effect.scoped(gitCore.checkoutBranch({ cwd, branch: resolvedBranch }));

      return {
        branchStep: { status: "created" as const, name: resolvedBranch },
        resolvedCommitMessage: suggestion.commitMessage,
        resolvedCommitSuggestion: suggestion,
      };
    });

  const runStackedAction: GitManagerShape["runStackedAction"] = Effect.fnUntraced(
    function* (input) {
      const wantsPush = input.action !== "commit";
      const wantsPr = input.action === "commit_push_pr";

      const initialStatus = yield* gitCore.statusDetails(input.cwd);
      if (!input.featureBranch && wantsPush && !initialStatus.branch) {
        return yield* gitManagerError("runStackedAction", "Cannot push from detached HEAD.");
      }
      if (!input.featureBranch && wantsPr && !initialStatus.branch) {
        return yield* gitManagerError(
          "runStackedAction",
          "Cannot create a review request from detached HEAD.",
        );
      }

      let branchStep: { status: "created" | "skipped_not_requested"; name?: string };
      let commitMessageForStep = input.commitMessage;
      let preResolvedCommitSuggestion: CommitAndBranchSuggestion | undefined = undefined;

      if (input.featureBranch) {
        const result = yield* runFeatureBranchStep(
          input.cwd,
          initialStatus.branch,
          input.commitMessage,
        );
        branchStep = result.branchStep;
        commitMessageForStep = result.resolvedCommitMessage;
        preResolvedCommitSuggestion = result.resolvedCommitSuggestion;
      } else {
        branchStep = { status: "skipped_not_requested" as const };
      }

      const currentBranch = branchStep.name ?? initialStatus.branch;

      const commit = yield* runCommitStep(
        input.cwd,
        currentBranch,
        commitMessageForStep,
        preResolvedCommitSuggestion,
      );

      const push = wantsPush
        ? yield* gitCore.pushCurrentBranch(input.cwd, currentBranch)
        : { status: "skipped_not_requested" as const };

      const pr = wantsPr
        ? yield* runPrStep(input.cwd, currentBranch)
        : { status: "skipped_not_requested" as const };

      return {
        action: input.action,
        branch: branchStep,
        commit,
        push,
        pr,
      };
    },
  );

  return {
    status,
    resolvePullRequest,
    preparePullRequestThread,
    runStackedAction,
  } satisfies GitManagerShape;
});

export const GitManagerLive = Layer.effect(GitManager, makeGitManager);
