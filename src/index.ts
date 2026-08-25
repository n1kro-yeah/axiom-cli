import { main } from "./cli/program.js";

export { main, VERSION } from "./cli/program.js";
export { loadPackageVersion } from "./cli/program.js";

const MINIMUM_NODE_MAJOR = 22;

function parseMajor(version: string): number | undefined {
  const match = /^v(\d+)/.exec(version);
  return match ? Number(match[1]) : undefined;
}

function guardRuntime(): void {
  const major = parseMajor(process.version);
  if (major === undefined || major < MINIMUM_NODE_MAJOR) {
    process.stderr.write(
      `axiom requires Node.js >= ${MINIMUM_NODE_MAJOR} (found ${process.version}).\nUpdate Node and retry.\n`
    );
    process.exit(2);
  }
}

function installCrashHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    const stack = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
    process.stderr.write(`\n[axiom] unhandled rejection: ${stack}\n`);
  });

  process.on("uncaughtException", (error) => {
    const stack = error instanceof Error ? error.stack ?? error.message : String(error);
    process.stderr.write(`\n[axiom] fatal: ${stack}\n`);
    process.exit(1);
  });
}

function normalizeWindowsStdio(): void {
  if (process.platform !== "win32") return;

  for (const stream of [process.stdout, process.stderr]) {
    try {
      stream.write("");
    } catch {
      void stream;
    }
  }

  if (!process.env["FORCE_COLOR"] && !process.env["NO_COLOR"]) {
    const supportsTruecolor =
      (process.env["WT_SESSION"] !== undefined && process.env["WT_SESSION"].length > 0) ||
      (process.env["TERM_PROGRAM"] === "vscode") ||
      (process.env["COLORTERM"] === "truecolor" || process.env["COLORTERM"] === "24bit");
    if (supportsTruecolor) {
      process.env["FORCE_COLOR"] = "3";
    } else {
      process.env["FORCE_COLOR"] = "1";
    }
  }
}

async function entry(): Promise<void> {
  guardRuntime();
  installCrashHandlers();
  normalizeWindowsStdio();

  const exitCode = await main({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: { ...process.env },
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY)
  });

  process.exitCode = exitCode;
}

entry().catch((error) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`\n[axiom] startup failure: ${message}\n`);
  process.exit(1);
});
