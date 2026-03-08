/**
 * GitForgeCli - Effect service contract for GitHub/GitLab review-request flows.
 *
 * Resolves the active forge for a repository and executes the matching CLI/API
 * commands needed for status inspection and review-request creation.
 *
 * @module GitForgeCli
 */
import type { GitForge } from "@t3tools/contracts";
import { ServiceMap } from "effect";
import type { Effect } from "effect";

import type { ProcessRunResult } from "../../processRunner";
import type { GitForgeCliError } from "../Errors.ts";

export interface GitReviewRequestSummary {
  readonly forge: GitForge;
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly baseRefName: string;
  readonly headRefName: string;
  readonly state: "open" | "closed" | "merged";
  readonly updatedAt: string | null;
}

export interface GitForgeCliShape {
  /**
   * Resolve the review forge for a repository, if one can be detected.
   */
  readonly resolveForge: (input: {
    readonly cwd: string;
  }) => Effect.Effect<GitForge | null, never>;

  /**
   * Execute a forge CLI command and return full process output.
   */
  readonly execute: (input: {
    readonly forge: GitForge;
    readonly cwd: string;
    readonly args: ReadonlyArray<string>;
    readonly timeoutMs?: number;
    readonly stdin?: string;
  }) => Effect.Effect<ProcessRunResult, GitForgeCliError>;

  /**
   * List review requests for a head branch.
   */
  readonly listReviewRequests: (input: {
    readonly cwd: string;
    readonly headBranch: string;
    readonly state: "open" | "all";
    readonly limit?: number;
  }) => Effect.Effect<ReadonlyArray<GitReviewRequestSummary>, GitForgeCliError>;

  /**
   * Create a review request from branch context and body file.
   */
  readonly createReviewRequest: (input: {
    readonly cwd: string;
    readonly baseBranch: string;
    readonly headBranch: string;
    readonly title: string;
    readonly bodyFile: string;
  }) => Effect.Effect<GitForge, GitForgeCliError>;

  /**
   * Resolve repository default branch through forge metadata.
   */
  readonly getDefaultBranch: (input: {
    readonly cwd: string;
  }) => Effect.Effect<string | null, GitForgeCliError>;
}

/**
 * GitForgeCli - Service tag for forge-specific review-request execution.
 */
export class GitForgeCli extends ServiceMap.Service<GitForgeCli, GitForgeCliShape>()(
  "t3/git/Services/GitForgeCli",
) {}
