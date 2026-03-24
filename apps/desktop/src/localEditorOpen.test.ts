import { describe, expect, it } from "vitest";

import { buildLocalEditorViaSshLaunch } from "./localEditorOpen";

describe("buildLocalEditorViaSshLaunch", () => {
  it("builds a VS Code folder-uri launch for SSH directories", () => {
    expect(
      buildLocalEditorViaSshLaunch({
        editor: "vscode",
        host: "bamboozler",
        remotePath: "/srv/project",
        targetKind: "directory",
      }),
    ).toEqual({
      command: "code",
      args: ["--folder-uri", "vscode-remote://ssh-remote+bamboozler/srv/project"],
    });
  });

  it("strips line suffixes when building VS Code file-uri launches", () => {
    expect(
      buildLocalEditorViaSshLaunch({
        editor: "vscode",
        host: "bamboozler",
        username: "epainchaud",
        port: 2222,
        remotePath: "/srv/project/src/app.ts:14:3",
        targetKind: "file",
      }),
    ).toEqual({
      command: "code",
      args: [
        "--file-uri",
        "vscode-remote://ssh-remote+epainchaud@bamboozler:2222/srv/project/src/app.ts",
      ],
    });
  });

  it("returns null for editors without local SSH support", () => {
    expect(
      buildLocalEditorViaSshLaunch({
        editor: "antigravity",
        host: "bamboozler",
        remotePath: "/srv/project",
        targetKind: "directory",
      }),
    ).toBeNull();
  });

  it("builds a Cursor remote launch for SSH directories", () => {
    expect(
      buildLocalEditorViaSshLaunch({
        editor: "cursor",
        host: "bamboozler",
        username: "epainchaud",
        port: 2222,
        remotePath: "/srv/project",
        targetKind: "directory",
      }),
    ).toEqual({
      command: "cursor",
      args: ["--remote", "ssh-remote+epainchaud@bamboozler:2222", "/srv/project"],
    });
  });

  it("builds a Zed SSH URL launch for remote files", () => {
    expect(
      buildLocalEditorViaSshLaunch({
        editor: "zed",
        host: "bamboozler",
        username: "epainchaud",
        remotePath: "/srv/project/src/app.ts:14:3",
        targetKind: "file",
      }),
    ).toEqual({
      command: "zed",
      args: ["ssh://epainchaud@bamboozler/srv/project/src/app.ts:14:3"],
    });
  });
});
