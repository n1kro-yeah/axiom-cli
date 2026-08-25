#!/usr/bin/env node

const MINIMUM_NODE_MAJOR = 22;

function parseNodeVersion(raw) {
  const match = /^v(\d+)\.(\d+)\.(\d+)/.exec(String(raw || ""));
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3])
  };
}

function isInteractiveTerminal(stream) {
  try {
    return Boolean(stream && stream.isTTY);
  } catch {
    return false;
  }
}

function printCrashBanner(error) {
  const lines = [
    "",
    "  Axiom crashed unexpectedly.",
    "",
    `  ${error && error.stack ? error.stack : String(error)}`,
    "",
    "  Please report this at https://github.com/axiom-cli/axiom/issues",
    ""
  ];
  process.stderr.write(lines.join("\n"));
}

function guardNodeVersion() {
  const version = parseNodeVersion(process.version);
  if (!version) {
    process.stderr.write(`Axiom could not parse the Node.js version: ${process.version}\n`);
    process.exit(1);
  }
  if (version.major < MINIMUM_NODE_MAJOR) {
    process.stderr.write(
      `Axiom requires Node.js >= ${MINIMUM_NODE_MAJOR}. You are running ${process.version}.\n` +
      "Upgrade Node.js at https://nodejs.org and try again.\n"
    );
    process.exit(1);
  }
}

function prepareWindowsConsole() {
  if (process.platform !== "win32") return;
  try {
    const anyProcess = process;
    if (typeof anyProcess.stdout?.handleType === "undefined") return;
  } catch {
  }
  process.env.__AXIOM_WINDOWS__ = "1";
}

async function main() {
  guardNodeVersion();
  prepareWindowsConsole();

  process.on("unhandledRejection", (reason) => {
    printCrashBanner(reason instanceof Error ? reason : new Error(String(reason)));
    process.exitCode = 1;
  });

  process.on("uncaughtException", (error) => {
    printCrashBanner(error);
    process.exit(1);
  });

  for (const signal of ["SIGINT", "SIGTERM"]) {
    try {
      process.on(signal, () => {
        process.exitCode = 130;
      });
    } catch {
    }
  }

  const moduleUrl = new URL("../dist/index.js", import.meta.url);

  let loaded;
  try {
    loaded = await import(moduleUrl.href);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      String(error.code) === "ERR_MODULE_NOT_FOUND"
    ) {
      process.stderr.write(
        "\nAxiom build output not found. Run `npm run build` inside the axiom repository first.\n\n"
      );
      process.exit(1);
    }
    throw error;
  }

  const entry = loaded && typeof loaded.main === "function" ? loaded.main : null;
  if (!entry) {
    process.stderr.write("Axiom entrypoint is malformed: main() export missing.\n");
    process.exit(1);
  }

  await entry({
    argv: process.argv.slice(2),
    cwd: process.cwd(),
    env: { ...process.env },
    interactive: isInteractiveTerminal(process.stdin) && isInteractiveTerminal(process.stdout),
    version: "0.1.0"
  });
}

main().catch((error) => {
  printCrashBanner(error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
});
