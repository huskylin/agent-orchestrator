#!/usr/bin/env node
// Phase 2 Wave Monitor
// 輪詢 .claude/tasks/*.json，當前 wave 全 merged 後自動 spawn 下一 wave impl agents
//
// 用法：node scripts/wave-monitor.mjs --ao-project paradise-soft --repo-path ~/projects/agent-orchestrator-demo
// 選項：
//   --ao-project  <id>    AO project ID（對應 agent-orchestrator.yaml 的 key）
//   --repo-path   <path>  demo 專案路徑（含 .claude/tasks/ 和 specs/）
//   --tasks-dir   <path>  override tasks 目錄（預設 <repo-path>/.claude/tasks）
//   --agent       <name>  impl agent name（預設 arcforge）
//   --interval-ms <ms>   輪詢間隔（預設 30000）
//   --once               只跑一次（不 loop，用於測試）
//   --dry-run            不實際 spawn

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    "ao-project":   { type: "string" },
    "repo-path":    { type: "string", default: process.cwd() },
    "tasks-dir":    { type: "string", default: "" },
    "agent":        { type: "string", default: "arcforge" },
    "interval-ms":  { type: "string", default: "30000" },
    "once":         { type: "boolean", default: false },
    "dry-run":      { type: "boolean", default: false },
  },
});

const aoProject  = args["ao-project"];
const repoPath   = resolve(args["repo-path"].replace(/^~/, homedir()));
const tasksDir   = args["tasks-dir"]
  ? resolve(args["tasks-dir"].replace(/^~/, homedir()))
  : join(repoPath, ".claude/tasks");
const agentName  = args["agent"];
const intervalMs = parseInt(args["interval-ms"], 10);
const once       = args["once"];
const dryRun     = args["dry-run"];

if (!aoProject) {
  console.error(
    "Usage: node wave-monitor.mjs --ao-project <id> --repo-path <path>",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Session metadata helpers
// ---------------------------------------------------------------------------

function getSessionsDir() {
  // Sessions 路徑：~/.agent-orchestrator/<sha256-12char-of-repoPath>/sessions
  const hash = createHash("sha256").update(repoPath).digest("hex").slice(0, 12);
  return join(homedir(), ".agent-orchestrator", hash, "sessions");
}

function getSessionBranch(sessionId) {
  const sessionsDir = getSessionsDir();
  const metadataPath = join(sessionsDir, sessionId, "metadata");
  if (!existsSync(metadataPath)) return null;

  const raw = readFileSync(metadataPath, "utf8");
  // metadata 格式：每行 key=value
  for (const line of raw.split("\n")) {
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    if (key === "branch") return val;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Task helpers
// ---------------------------------------------------------------------------

function loadTasks() {
  let files;
  try {
    files = readdirSync(tasksDir).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }

  return files.map((f) => {
    const raw = JSON.parse(readFileSync(join(tasksDir, f), "utf8"));
    return { ...raw, _file: join(tasksDir, f) };
  });
}

function saveTask(task) {
  const { _file, ...data } = task;
  writeFileSync(_file, JSON.stringify(data, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

function getMergedBranches() {
  try {
    const output = execSync("git branch -r --merged origin/main", {
      cwd: repoPath,
      encoding: "utf8",
    });
    return new Set(output.split("\n").map((b) => b.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function isBranchMerged(branchName, mergedSet) {
  if (!branchName) return false;
  return mergedSet.has(`origin/${branchName}`) || mergedSet.has(branchName);
}

// ---------------------------------------------------------------------------
// Wave logic
// ---------------------------------------------------------------------------

function getCurrentWave(tasks) {
  const activeWaveNums = tasks
    .filter((t) => t.status === "pending" || t.status === "in_progress")
    .map((t) => parseInt(t.metadata?.wave ?? "999", 10));

  if (activeWaveNums.length === 0) return null;
  return Math.min(...activeWaveNums);
}

function isReadyToSpawn(task, tasks) {
  return (task.blockedBy ?? []).every((depId) => {
    const dep = tasks.find((t) => t.id === depId);
    return dep?.status === "done";
  });
}

// ---------------------------------------------------------------------------
// Spawn impl session
// ---------------------------------------------------------------------------

function spawnImplSession(task) {
  const issueId  = task.metadata?.jira_id;
  const specFile = task.metadata?.spec_file ?? `specs/${issueId}.md`;

  if (!issueId) {
    console.warn(`[wave-monitor] task ${task.id} 沒有 jira_id，跳過`);
    return null;
  }

  const prompt = `請依照 ${specFile} 的規格進行實作。遵循 agentRules 要求，完成後開 PR。`;
  const escapedPrompt = prompt.replace(/'/g, "'\\''");
  const cmd = [
    "ao spawn",
    issueId,
    `--agent ${agentName}`,
    "--session-type impl",
    `--prompt '${escapedPrompt}'`,
  ].join(" ");

  console.log(`[wave-monitor] spawning impl session for ${issueId} (task ${task.id})`);

  if (dryRun) {
    console.log(`[dry-run] ${cmd}`);
    return "dry-run-session";
  }

  try {
    const output = execSync(cmd, {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
    });
    const sessionMatch = output.match(/SESSION=(\S+)/);
    const sessionId = sessionMatch?.[1] ?? null;
    if (sessionId) {
      console.log(`[wave-monitor] ✓ ${issueId} → session ${sessionId}`);
    }
    return sessionId;
  } catch (err) {
    console.error(`[wave-monitor] ✗ spawn 失敗 ${issueId}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main poll cycle
// ---------------------------------------------------------------------------

async function poll() {
  const tasks = loadTasks();

  if (tasks.length === 0) {
    console.log("[wave-monitor] tasks 目錄中沒有 task，結束。");
    return false;
  }

  // Step 0: 補充缺少 branch 的 in_progress tasks（session spawn 後才能取得 branch）
  for (const task of tasks.filter(
    (t) => t.status === "in_progress" && !t.metadata?.branch && t.metadata?.session_id,
  )) {
    const branch = getSessionBranch(task.metadata.session_id);
    if (branch) {
      task.metadata = { ...task.metadata, branch };
      saveTask(task);
      console.log(`[wave-monitor] task ${task.id} 補充 branch: ${branch}`);
    }
  }

  // Step 1: 更新已 merge 的 in_progress tasks → done
  const mergedBranches = getMergedBranches();
  for (const task of tasks.filter((t) => t.status === "in_progress")) {
    const branch = task.metadata?.branch;
    if (branch && isBranchMerged(branch, mergedBranches)) {
      console.log(
        `[wave-monitor] task ${task.id} (${task.metadata?.jira_id}) branch merged → done`,
      );
      task.status = "done";
      saveTask(task);
    }
  }

  // Step 2: 找當前 wave
  const currentWave = getCurrentWave(tasks);

  if (currentWave === null) {
    console.log("[wave-monitor] 🎉 所有 wave 已完成！");
    return false;
  }

  console.log(`[wave-monitor] 當前 wave: ${currentWave}`);

  // Step 3: Spawn 當前 wave 中 pending 且 blockedBy 全 done 的 tasks
  const waveTasks = tasks.filter(
    (t) => parseInt(t.metadata?.wave ?? "999", 10) === currentWave,
  );

  const pendingInWave = waveTasks.filter((t) => t.status === "pending");
  if (pendingInWave.length === 0) {
    console.log(`[wave-monitor] wave ${currentWave} 全部 in_progress，等待 merge...`);
    return true;
  }

  for (const task of pendingInWave) {
    if (!isReadyToSpawn(task, tasks)) {
      console.log(`[wave-monitor] task ${task.id} 有未完成的依賴，跳過`);
      continue;
    }

    const sessionId = spawnImplSession(task);

    if (sessionId) {
      task.status = "in_progress";
      task.metadata = { ...(task.metadata ?? {}), session_id: sessionId };
      saveTask(task);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

console.log(`[wave-monitor] 啟動 (interval=${intervalMs}ms, dry-run=${dryRun})`);
console.log(`[wave-monitor] tasks dir: ${tasksDir}`);
console.log(`[wave-monitor] repo path: ${repoPath}`);
console.log(`[wave-monitor] sessions dir: ${getSessionsDir()}`);

async function loop() {
  const shouldContinue = await poll();

  if (!shouldContinue || once) {
    console.log("[wave-monitor] 結束");
    return;
  }

  setTimeout(loop, intervalMs);
}

loop().catch((err) => {
  console.error("[wave-monitor] 嚴重錯誤:", err);
  process.exit(1);
});
