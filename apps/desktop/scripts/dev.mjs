import { spawn, spawnSync } from "node:child_process";

const bunExecutable = process.env.npm_execpath ?? "bun";
const childProcesses = new Set();
let shuttingDown = false;

function killChildTreeByPid(pid, signal) {
  if (process.platform === "win32" || typeof pid !== "number") {
    return;
  }

  spawnSync("pkill", [`-${signal}`, "-P", String(pid)], { stdio: "ignore" });
}

function stopChildren(signal) {
  for (const child of childProcesses) {
    child.kill(signal);
    killChildTreeByPid(child.pid, signal === "SIGTERM" ? "TERM" : "KILL");
  }
}

function shutdown(exitCode) {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  stopChildren("SIGTERM");

  setTimeout(() => {
    stopChildren("SIGKILL");
    process.exit(exitCode);
  }, 1_500).unref();
}

function startScript(name) {
  const child = spawn(bunExecutable, ["run", name], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });

  childProcesses.add(child);

  child.once("exit", (code, signal) => {
    childProcesses.delete(child);

    if (shuttingDown) {
      if (childProcesses.size === 0) {
        process.exit(exitCodeFromExit(code, signal));
      }
      return;
    }

    shuttingDown = true;
    stopChildren("SIGTERM");

    setTimeout(() => {
      stopChildren("SIGKILL");
      process.exit(exitCodeFromExit(code, signal));
    }, 1_500).unref();
  });

  child.once("error", () => {
    shutdown(1);
  });
}

function exitCodeFromExit(code, signal) {
  if (typeof code === "number") {
    return code;
  }

  if (signal === "SIGINT") {
    return 130;
  }

  if (signal === "SIGTERM") {
    return 143;
  }

  return 1;
}

startScript("dev:bundle");
startScript("dev:electron");

process.once("SIGINT", () => {
  shutdown(130);
});

process.once("SIGTERM", () => {
  shutdown(143);
});
