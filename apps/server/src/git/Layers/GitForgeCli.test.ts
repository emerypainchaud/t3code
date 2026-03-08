import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, assert, describe, it, vi } from "vitest";
import { Effect } from "effect";
import type { ProcessRunOptions, ProcessRunResult } from "../../processRunner";

const { runProcessMock } = vi.hoisted(() => ({
  runProcessMock:
    vi.fn<
      (
        command: string,
        args: readonly string[],
        options?: ProcessRunOptions,
      ) => Promise<ProcessRunResult>
    >(),
}));

vi.mock("../../processRunner", () => ({
  runProcess: runProcessMock,
}));

function processResult(
  overrides: Partial<ProcessRunResult> & Pick<ProcessRunResult, "stdout" | "code">,
): ProcessRunResult {
  return {
    stdout: overrides.stdout,
    code: overrides.code,
    stderr: overrides.stderr ?? "",
    signal: overrides.signal ?? null,
    timedOut: overrides.timedOut ?? false,
    stdoutTruncated: overrides.stdoutTruncated ?? false,
    stderrTruncated: overrides.stderrTruncated ?? false,
  };
}

describe("GitForgeCli", () => {
  afterEach(() => {
    runProcessMock.mockReset();
    vi.resetModules();
  });

  it("posts GitLab merge requests through stdin json instead of argv description fields", async () => {
    const calls: Array<{
      command: string;
      args: readonly string[];
      options?: ProcessRunOptions;
    }> = [];

    runProcessMock.mockImplementation(async (command, args, options) => {
      calls.push({
        command,
        args,
        ...(options !== undefined ? { options } : {}),
      });

      if (command === "git" && args[0] === "config") {
        return processResult({
          code: 0,
          stdout: "git@gitlab.example.com:group/project.git\n",
        });
      }

      if (command === "glab" && args[0] === "api") {
        return processResult({
          code: 0,
          stdout: '{"iid":19}',
        });
      }

      throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
    });

    const { makeGitForgeCli } = await import("./GitForgeCli.ts");
    const service = await Effect.runPromise(makeGitForgeCli);
    const bodyFile = path.join(os.tmpdir(), `t3code-gitforgecli-${process.pid}.md`);
    fs.writeFileSync(bodyFile, "## Summary\n- Add MR support\n");

    const forge = await Effect.runPromise(
      service.createReviewRequest({
        cwd: "/virtual/repo",
        baseBranch: "main",
        headBranch: "feature/test",
        title: "Add MR support",
        bodyFile,
      }),
    );

    assert.equal(forge, "gitlab");
    const glabCall = calls.find((entry) => entry.command === "glab");
    assert.isDefined(glabCall);
    assert.isTrue(glabCall?.args.includes("--input") ?? false);
    assert.isTrue(glabCall?.args.includes("-") ?? false);
    assert.isFalse(glabCall?.args.includes("--raw-field") ?? true);
    assert.equal(
      glabCall?.options?.stdin,
      JSON.stringify({
        source_branch: "feature/test",
        target_branch: "main",
        title: "Add MR support",
        description: "## Summary\n- Add MR support\n",
      }),
    );
    fs.unlinkSync(bodyFile);
  });
});
