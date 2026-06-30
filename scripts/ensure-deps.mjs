// Guard run automatically before dev/build/tauri (npm "pre" lifecycle hooks).
// Ensures every dependency declared in package.json is actually present in
// node_modules, and runs `npm install` only when something is missing.
//
// This catches the case where package.json lists a package (e.g. a newly
// added @xterm addon) but the local node_modules is out of sync — which
// otherwise surfaces as a cryptic Vite "Failed to resolve import" error.
//
// Cross-platform (Windows + macOS + Linux): pure Node, no shell assumptions.

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const declared = {
  ...(pkg.dependencies ?? {}),
  ...(pkg.devDependencies ?? {}),
};

const missing = Object.keys(declared).filter(
  (name) => !existsSync(join(root, "node_modules", name, "package.json"))
);

if (missing.length === 0) {
  process.exit(0);
}

console.log(
  `\n[ensure-deps] Missing ${missing.length} package(s): ${missing.join(", ")}`
);
console.log("[ensure-deps] Running `npm install`...\n");

const result = spawnSync("npm", ["install"], {
  cwd: root,
  stdio: "inherit",
  shell: process.platform === "win32", // npm is npm.cmd on Windows
});

process.exit(result.status ?? 0);
