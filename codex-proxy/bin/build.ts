import { existsSync, mkdirSync, rmSync } from "fs";
import { resolve } from "path";

interface BuildTarget {
  entrypoint: string;
  outfile: string;
}

const ROOT = process.cwd();
const DIST_DIR = resolve(ROOT, "dist");
const targets: BuildTarget[] = [
  { entrypoint: resolve(ROOT, "bin/proxy.ts"), outfile: resolve(DIST_DIR, "proxy.js") },
  { entrypoint: resolve(ROOT, "bin/peek.ts"), outfile: resolve(DIST_DIR, "peek.js") },
];

function resetDistDir() {
  if (existsSync(DIST_DIR)) {
    rmSync(DIST_DIR, { force: true, recursive: true });
  }
  mkdirSync(DIST_DIR, { recursive: true });
}

async function buildTarget(target: BuildTarget) {
  const result = await Bun.build({
    entrypoints: [target.entrypoint],
    outfile: target.outfile,
    target: "bun",
    format: "esm",
  });

  if (!result.success) {
    for (const log of result.logs) {
      console.error(log);
    }
    throw new Error(`Build failed for ${target.entrypoint}`);
  }

  if (result.outputs.length === 0) {
    throw new Error(`Build produced no outputs for ${target.entrypoint}`);
  }

  await Bun.write(target.outfile, result.outputs[0]);
  console.log(`[build] wrote ${target.outfile}`);
}

async function main() {
  resetDistDir();

  for (const target of targets) {
    await buildTarget(target);
  }

  console.log(`[build] done: ${DIST_DIR}`);
}

await main();
