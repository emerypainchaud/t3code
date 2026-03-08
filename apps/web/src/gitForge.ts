import type { GitForge } from "@t3tools/contracts";

export function reviewRequestShortLabel(forge: GitForge | null | undefined): "PR" | "MR" {
  return forge === "gitlab" ? "MR" : "PR";
}

export function reviewRequestLongLabel(
  forge: GitForge | null | undefined,
): "pull request" | "merge request" {
  return forge === "gitlab" ? "merge request" : "pull request";
}

export function openReviewRequestLabel(forge: GitForge | null | undefined): string {
  return `Open ${reviewRequestShortLabel(forge)}`;
}

export function createReviewRequestLabel(forge: GitForge | null | undefined): string {
  return `Create ${reviewRequestShortLabel(forge)}`;
}

export function pushAndCreateReviewRequestLabel(forge: GitForge | null | undefined): string {
  return `Push & create ${reviewRequestShortLabel(forge)}`;
}

export function commitPushAndCreateReviewRequestLabel(
  forge: GitForge | null | undefined,
): string {
  return `Commit, push & create ${reviewRequestShortLabel(forge)}`;
}

export function creatingReviewRequestLabel(forge: GitForge | null | undefined): string {
  return `Creating ${reviewRequestShortLabel(forge)}...`;
}

export function createdReviewRequestTitle(
  forge: GitForge | null | undefined,
  status: "created" | "opened_existing",
  number?: number,
): string {
  const noun = reviewRequestShortLabel(forge);
  const suffix = number ? ` #${number}` : "";
  return `${status === "created" ? "Created" : "Opened"} ${noun}${suffix}`;
}
