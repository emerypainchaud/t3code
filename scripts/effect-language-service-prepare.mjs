#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const workspaceDir = process.cwd();
const cliPath = join(repoRoot, "node_modules", "@effect", "language-service", "cli.js");
const rootTypescriptPath = join(repoRoot, "node_modules", "typescript");
const workspaceNodeModulesPath = join(workspaceDir, "node_modules");
const workspaceTypescriptPath = join(workspaceNodeModulesPath, "typescript");

if (!existsSync(cliPath)) {
  console.warn("[prepare] Skipping effect-language-service patch: CLI is not installed yet.");
  process.exit(0);
}

if (!existsSync(rootTypescriptPath) && !existsSync(workspaceTypescriptPath)) {
  console.warn("[prepare] Skipping effect-language-service patch: TypeScript is not installed yet.");
  process.exit(0);
}

let createdNodeModulesDir = false;
let createdTypescriptLink = false;

try {
  if (!existsSync(workspaceTypescriptPath) && existsSync(rootTypescriptPath)) {
    if (!existsSync(workspaceNodeModulesPath)) {
      mkdirSync(workspaceNodeModulesPath, { recursive: true });
      createdNodeModulesDir = true;
    }

    symlinkSync(
      relative(workspaceNodeModulesPath, rootTypescriptPath),
      workspaceTypescriptPath,
      process.platform === "win32" ? "junction" : "dir",
    );
    createdTypescriptLink = true;
  }

  const result = spawnSync(process.execPath, [cliPath, "patch"], {
    cwd: workspaceDir,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 0);
} finally {
  if (createdTypescriptLink) {
    rmSync(workspaceTypescriptPath, { force: true, recursive: true });
  }

  if (createdNodeModulesDir) {
    rmSync(workspaceNodeModulesPath, { force: true, recursive: true });
  }
}
