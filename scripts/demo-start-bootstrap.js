#!/usr/bin/env node
/**
 * @file scripts/demo-start-bootstrap.js
 * @description Bootstrap wrapper for `npm run demo:start`.
 *
 * Goal: make startup one command, even on first run.
 * If local dependencies are missing, install them first, then run the
 * TypeScript startup sequence (`demo:start:internal`).
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const BIN_DIR = path.join(ROOT, "node_modules", ".bin");

function binPath(name) {
  if (process.platform === "win32") return path.join(BIN_DIR, `${name}.cmd`);
  return path.join(BIN_DIR, name);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(`Failed to run '${command} ${args.join(" ")}':`, result.error.message);
    process.exit(1);
  }

  if (typeof result.status === "number" && result.status !== 0) {
    process.exit(result.status);
  }
}

function needsInstall() {
  const nodeModulesDir = path.join(ROOT, "node_modules");
  if (!fs.existsSync(nodeModulesDir)) return true;
  if (!fs.existsSync(binPath("ts-node"))) return true;
  if (!fs.existsSync(binPath("concurrently"))) return true;
  return false;
}

function ensureDependencies() {
  if (!needsInstall()) return;
  console.log("\nDependencies not found. Installing project dependencies...\n");
  run("npm", ["install"]);
}

function main() {
  ensureDependencies();
  run("npm", ["run", "demo:start:internal"]);
}

main();
