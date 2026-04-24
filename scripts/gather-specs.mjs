#!/usr/bin/env node
// gather-specs.mjs
// 從所有 sessionType=spec 的 session worktree 蒐集 specs/*.md，複製到主 repo 的 specs/ 目錄
//
// 用法：node scripts/gather-specs.mjs --repo-path ~/projects/agent-orchestrator-demo
// 選項：
//   --repo-path  <path>   主 repo 路徑（含 agent-orchestrator.yaml）
//   --specs-dir  <path>   主 repo 的 specs 目錄（預設 <repo-path>/specs）
//   --dry-run            只印出會複製的檔案，不實際複製

import { readFileSync, copyFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "repo-path":  { type: "string", default: process.cwd() },
    "specs-dir":  { type: "string", default: "" },
    "dry-run":    { type: "boolean", default: false },
  },
});

const repoPath = resolve(args["repo-path"].replace(/^~/, homedir()));
const specsDir = args["specs-dir"]
  ? resolve(args["specs-dir"].replace(/^~/, homedir()))
  : join(repoPath, "specs");
const dryRun = args["dry-run"];

// ---------------------------------------------------------------------------
// 找 sessions 目錄
// 格式：~/.agent-orchestrator/<hash>-<project-dir-name>/sessions/
// ---------------------------------------------------------------------------
function findSessionsDir() {
  const aoDir = join(homedir(), ".agent-orchestrator");
  const repoDirName = basename(repoPath);

  // 找所有以 repoPath dir name 結尾的目錄（例如 46624f309d9d-agent-orchestrator-demo）
  let dirs;
  try {
    dirs = readdirSync(aoDir);
  } catch {
    throw new Error(`找不到 ~/.agent-orchestrator 目錄`);
  }

  const matched = dirs.find(
    (d) => d.endsWith(`-${repoDirName}`) && existsSync(join(aoDir, d, "sessions")),
  );

  if (!matched) {
    throw new Error(`找不到對應 ${repoDirName} 的 sessions 目錄`);
  }

  return join(aoDir, matched, "sessions");
}

// ---------------------------------------------------------------------------
// 解析 key=value 格式的 session 檔案
// ---------------------------------------------------------------------------
function parseSessionFile(content) {
  const result = {};
  for (const line of content.split("\n")) {
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
const sessionsDir = findSessionsDir();
console.log(`[gather-specs] sessions dir: ${sessionsDir}`);

let sessionFiles;
try {
  sessionFiles = readdirSync(sessionsDir).filter(
    (f) => !f.startsWith(".") && !f.includes("archive"),
  );
} catch {
  console.error(`[gather-specs] 無法讀取 sessions 目錄`);
  process.exit(1);
}

const specSessions = [];
for (const sessionId of sessionFiles) {
  const sessionPath = join(sessionsDir, sessionId);
  let content;
  try {
    content = readFileSync(sessionPath, "utf8");
  } catch {
    continue;
  }

  // session 可能是檔案（key=value）或目錄
  if (!content.includes("worktree=")) continue;

  const meta = parseSessionFile(content);
  if (meta.sessionType === "spec" && meta.worktree) {
    specSessions.push({ sessionId, worktree: meta.worktree, branch: meta.branch });
  }
}

if (specSessions.length === 0) {
  console.warn("[gather-specs] 找不到任何 sessionType=spec 的 session");
  console.warn("[gather-specs] 提示：若 sessions 是舊版（無 sessionType），請手動指定 specs 目錄");
  process.exit(0);
}

console.log(`[gather-specs] 找到 ${specSessions.length} 個 spec sessions`);

// 確保目標 specs 目錄存在
if (!dryRun) mkdirSync(specsDir, { recursive: true });

let copied = 0;
for (const { sessionId, worktree, branch } of specSessions) {
  const worktreeSpecsDir = join(worktree, "specs");
  if (!existsSync(worktreeSpecsDir)) {
    console.warn(`[gather-specs] ${sessionId} (${branch}): specs/ 目錄不存在，跳過`);
    continue;
  }

  let specFiles;
  try {
    specFiles = readdirSync(worktreeSpecsDir).filter((f) => f.endsWith(".md"));
  } catch {
    continue;
  }

  if (specFiles.length === 0) {
    console.warn(`[gather-specs] ${sessionId} (${branch}): specs/ 目錄是空的`);
    continue;
  }

  for (const file of specFiles) {
    const src = join(worktreeSpecsDir, file);
    const dst = join(specsDir, file);
    console.log(`[gather-specs] ${sessionId}: ${file} → ${dst}`);
    if (!dryRun) {
      copyFileSync(src, dst);
      copied++;
    }
  }
}

if (dryRun) {
  console.log(`[gather-specs] dry-run 完成`);
} else {
  console.log(`[gather-specs] 完成 — 複製了 ${copied} 個 spec 檔案到 ${specsDir}`);
}
