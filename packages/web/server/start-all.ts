/**
 * Production entry point — starts Next.js + terminal servers.
 * Used by `ao start` when running from an npm install (no monorepo).
 * Replaces the dev-only `concurrently` setup.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve paths relative to the package root (one level up from dist-server/)
const pkgRoot = resolve(__dirname, "..");

const children: ChildProcess[] = [];

function log(label: string, msg: string): void {
  process.stdout.write(`[${label}] ${msg}\n`);
}

function spawnProcess(
  label: string,
  command: string,
  args: string[],
  opts?: { restart?: boolean; maxRestarts?: number; env?: Record<string, string> },
): ChildProcess {
  let restarts = 0;
  const maxRestarts = opts?.maxRestarts ?? 3;
  let slotIndex = -1;

  function launch(): ChildProcess {
    const child = spawn(command, args, {
      cwd: pkgRoot,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(opts?.env ?? {}) },
    });

    child.stdout?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        log(label, line);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      for (const line of data.toString().split("\n").filter(Boolean)) {
        log(label, line);
      }
    });

    child.on("exit", (code) => {
      log(label, `exited with code ${code}`);
      if (!shuttingDown && opts?.restart && code !== 0 && restarts < maxRestarts) {
        restarts++;
        log(label, `restarting (attempt ${restarts}/${maxRestarts})`);
        const replacement = launch();
        // Replace in-place — slot was assigned on first push
        children[slotIndex] = replacement;
      }
    });

    // Only push on first launch; restarts replace the existing slot
    if (slotIndex === -1) {
      slotIndex = children.length;
      children.push(child);
    }

    return child;
  }

  return launch();
}

/**
 * Resolve the `next` CLI binary path.
 * Tries the local .bin shim first (fast), then falls back to require.resolve (hoisted deps).
 */
function resolveNextBin(): string {
  // Prefer the JS entry over the .bin shell wrapper so we can spawn it via
  // `node --require <preload>` (the shell wrapper can't be `node`-loaded).
  const require = createRequire(resolve(pkgRoot, "package.json"));
  try {
    const nextPkg = require.resolve("next/package.json");
    const jsBin = resolve(dirname(nextPkg), "dist", "bin", "next");
    if (existsSync(jsBin)) return jsBin;
  } catch {
    // Fall through to .bin shim
  }

  const localBin = resolve(pkgRoot, "node_modules", ".bin", "next");
  if (existsSync(localBin)) return localBin;

  return "next";
}

// Start Next.js production server.
// Spawn via `node --require silence-rejection.cjs <next-bin> start -p PORT`
// so the preload installs an unhandledRejection handler BEFORE Next.js wires
// up its own (which would call process.exit on transient SSE stream errors).
const port = process.env["PORT"] || "3000";
const silenceScript = resolve(__dirname, "silence-rejection.js");
const nextArgs = [
  "--require",
  silenceScript,
  "--unhandled-rejections=warn",
  resolveNextBin(),
  "start",
  "-p",
  port,
];
log("start-all", `spawning: ${process.execPath} ${nextArgs.join(" ")}`);
spawnProcess("next", process.execPath, nextArgs, { restart: true });

// Start direct terminal WebSocket server (auto-restart on crash)
spawnProcess("direct-terminal", "node", [resolve(__dirname, "direct-terminal-ws.js")], { restart: true });

// Graceful shutdown — send SIGTERM to children and wait for them to exit
let shuttingDown = false;

function cleanup(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  let alive = children.length;
  if (alive === 0) {
    process.exit(0);
    return;
  }

  // Force exit after 5s if children don't exit cleanly
  const forceTimer = setTimeout(() => {
    log("start-all", "Children did not exit in time, forcing shutdown");
    process.exit(1);
  }, 5000);
  forceTimer.unref();

  for (const child of children) {
    child.on("exit", () => {
      alive--;
      if (alive <= 0) {
        clearTimeout(forceTimer);
        process.exit(0);
      }
    });
    child.kill("SIGTERM");
  }
}

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);
