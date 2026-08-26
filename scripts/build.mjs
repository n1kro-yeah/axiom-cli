import { build } from "esbuild";
import { mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

const outfile = "dist/index.js";
const sourcemapOutfile = `${outfile}.map`;

async function previousBundleSize() {
  try {
    const info = await stat(outfile);
    return info.size;
  } catch {
    return 0;
  }
}

async function cleanStaleArtifacts() {
  for (const candidate of [join("dist", "index.js.tmp")]) {
    try {
      await unlink(candidate);
    } catch {
    }
  }
}

async function main() {
  const startedAt = Date.now();
  const before = await previousBundleSize();

  await mkdir("dist", { recursive: true });
  await cleanStaleArtifacts();

  const result = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node22",
    outfile,
    sourcemap: true,
    logLevel: "warning",
    metafile: false,
    minify: false,
    keepNames: true,
    legalComments: "none",
    define: {
      "process.env.NODE_ENV": '"production"'
    },
    external: ["fsevents"]
  });

  if (result.errors.length > 0) {
    console.error(`build failed with ${result.errors.length} error(s)`);
    process.exit(1);
  }

  const after = await stat(outfile);
  const durationMs = Date.now() - startedAt;

  console.log(
    `bundle written: ${outfile} (${(after.size / 1024 / 1024).toFixed(2)} MB` +
      `${before > 0 ? `, was ${(before / 1024 / 1024).toFixed(2)} MB` : ""}) in ${durationMs}ms`
  );

  if (after.size < 100000) {
    console.error("suspiciously small bundle; aborting");
    process.exit(1);
  }

  void sourcemapOutfile;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
