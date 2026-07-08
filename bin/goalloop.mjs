#!/usr/bin/env node
/**
 * Global entrypoint for goalloop.
 * Runs the orchestrator in the caller's cwd so .goalloop/ state lands in the active project.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const defaultRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = process.env.GOALLOOP_HOME?.trim() || defaultRoot;
const orchestrator = join(root, "src/orchestrator.ts");
const nodeModules = join(root, "node_modules");

if (!existsSync(orchestrator)) {
  console.error(`goalloop: orchestrator not found at ${orchestrator}`);
  console.error("Set GOALLOOP_HOME to your goalloop checkout or run scripts/install-global.sh");
  process.exit(1);
}

if (!existsSync(nodeModules)) {
  console.error(`goalloop: dependencies missing in ${root}`);
  console.error(`Run: cd "${root}" && pnpm install`);
  process.exit(1);
}

const tsx = join(nodeModules, ".bin/tsx");
const runner = existsSync(tsx) ? tsx : "tsx";
const args = process.argv.slice(2);

const result = spawnSync(runner, [orchestrator, ...args], {
  stdio: "inherit",
  cwd: process.cwd(),
  env: {
    ...process.env,
    GOALLOOP_HOME: root,
  },
});

process.exit(result.status ?? (result.signal ? 1 : 0));
