#!/usr/bin/env node
// Jira Sprint Watcher — 自動偵測新 sprint 並觸發 Phase 0 流水線
//
// 相容 Jira Server 8.x（REST API v2）。
// 不使用 Agile API，改用 JQL sprint in openSprints() 取得當前 sprint 資訊。
//
// 用法：node scripts/jira-sprint-watcher.mjs \
//         --jira-project MOPFREQ \
//         --jira-url https://jira.yourcompany.com \
//         --ao-project paradise-soft \
//         [--interval-ms 300000]   # 輪詢間隔，預設 5 分鐘
//         [--state-file .sprint-watcher-MOPFREQ.json]
//         [--phase0-script path/to/phase0-spawn-specs.mjs]
//         [--prompt-file path/to/spec-agent.md]
//         [--dry-run]
//         [--once]
//
// 環境變數（與 tracker-jira plugin 相同）：
//   JIRA_EMAIL   — Jira 登入帳號（email 或 username）
//   JIRA_TOKEN   — Jira API token 或密碼

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    "jira-project":  { type: "string" },
    "jira-url":      { type: "string" },
    "ao-project":    { type: "string" },
    "interval-ms":   { type: "string", default: "300000" },
    "state-file":    { type: "string", default: "" },
    "phase0-script": { type: "string", default: "" },
    "prompt-file":   { type: "string", default: "" },
    "dry-run":       { type: "boolean", default: false },
    "once":          { type: "boolean", default: false },
  },
});

const jiraProject = args["jira-project"];
const jiraUrl     = args["jira-url"]?.replace(/\/$/, "");
const aoProject   = args["ao-project"];
const intervalMs  = parseInt(args["interval-ms"], 10);
const dryRun      = args["dry-run"];
const once        = args["once"];

if (!jiraProject || !jiraUrl || !aoProject) {
  console.error(
    "Usage: node jira-sprint-watcher.mjs" +
    " --jira-project MOPFREQ --jira-url https://... --ao-project paradise-soft",
  );
  process.exit(1);
}

const stateFile = args["state-file"]
  ? resolve(args["state-file"])
  : resolve(process.cwd(), `.sprint-watcher-${jiraProject.toLowerCase()}.json`);

const phase0Script = args["phase0-script"]
  ? resolve(args["phase0-script"])
  : join(__dirname, "phase0-spawn-specs.mjs");

// ---------------------------------------------------------------------------
// Auth — 對齊 tracker-jira plugin 的慣例（JIRA_EMAIL + JIRA_TOKEN）
// ---------------------------------------------------------------------------
const email = process.env.JIRA_EMAIL ?? "";
const token = process.env.JIRA_TOKEN ?? "";

if (!email || !token) {
  console.error("[sprint-watcher] 需要設定環境變數 JIRA_EMAIL 和 JIRA_TOKEN");
  process.exit(1);
}

const authHeader = "Basic " + Buffer.from(`${email}:${token}`).toString("base64");

// ---------------------------------------------------------------------------
// Jira REST API v2 fetch helper（與 tracker-jira 相同路徑格式）
// ---------------------------------------------------------------------------
async function jiraFetch(path, options = {}) {
  const url = `${jiraUrl}/rest/api/2${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira API ${options.method ?? "GET"} ${path} 失敗 (${res.status}): ${body}`);
  }

  if (res.status === 204) return undefined;
  return res.json();
}

// ---------------------------------------------------------------------------
// Sprint 資訊解析
//
// 舊版 Jira Server 的 sprint 欄位（customfield_10020）有兩種格式：
//   1. 物件陣列（較新版）：[{ id: 42, name: "Sprint 5", state: "ACTIVE", ... }]
//   2. 字串陣列（較舊版）：["com.atlassian...Sprint@xxx[id=42,name=Sprint 5,state=ACTIVE,...]"]
//
// 兩種格式都嘗試解析，取得 sprint name 與 id。
// ---------------------------------------------------------------------------
function parseSprintField(field) {
  if (!field) return null;

  const items = Array.isArray(field) ? field : [field];
  // 找 active sprint
  for (const item of items) {
    if (typeof item === "object" && item !== null) {
      if (
        item.state === "ACTIVE" ||
        item.state === "active" ||
        !item.state // 有些版本不帶 state
      ) {
        return { id: String(item.id ?? ""), name: item.name ?? "" };
      }
    }

    if (typeof item === "string") {
      // 解析 Greenhopper 格式字串：id=42,name=Sprint 5,state=ACTIVE
      const idMatch   = item.match(/\bid=(\d+)/);
      const nameMatch = item.match(/\bname=([^,\]]+)/);
      const stateMatch = item.match(/\bstate=([^,\]]+)/);
      const state = stateMatch?.[1]?.toUpperCase() ?? "";
      if (state === "ACTIVE" || !stateMatch) {
        return {
          id:   idMatch?.[1] ?? "",
          name: nameMatch?.[1]?.trim() ?? "",
        };
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 取得目前 active sprint（透過 JQL + customfield_10020）
// ---------------------------------------------------------------------------
async function getActiveSprint() {
  // 1. 先查一批 open sprint 的 issues，從 customfield_10020 取 sprint 資訊
  const jql = `project = ${jiraProject} AND sprint in openSprints() ORDER BY created DESC`;
  const data = await jiraFetch(
    `/search?jql=${encodeURIComponent(jql)}&maxResults=5&fields=summary,customfield_10020`,
  );

  if (!data.issues || data.issues.length === 0) {
    return null; // 沒有 open sprint 的 issue
  }

  // 從第一個 issue 的 sprint 欄位解析
  for (const issue of data.issues) {
    const sprintField = issue.fields?.customfield_10020;
    const sprint = parseSprintField(sprintField);
    if (sprint && sprint.name) {
      return {
        id:         sprint.id,
        name:       sprint.name,
        issueCount: data.total,
      };
    }
  }

  // fallback：sprint 欄位不可用時，用 issue key 的 hash 作為 sprint 識別
  const issueKeys = data.issues.map((i) => i.key).sort().join(",");
  const hash = createHash("sha256").update(issueKeys).digest("hex").slice(0, 8);
  console.warn(
    "[sprint-watcher] 無法從 customfield_10020 取得 sprint 資訊，" +
    `改用 issue-set hash 作為 sprint 識別（hash=${hash}）`,
  );
  return {
    id:         hash,
    name:       `openSprint-${hash}`,
    issueCount: data.total,
  };
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------
function loadState() {
  if (!existsSync(stateFile)) {
    return { lastSprintId: null, lastSprintName: null, triggeredAt: null };
  }
  try {
    return JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    return { lastSprintId: null, lastSprintName: null, triggeredAt: null };
  }
}

function saveState(state) {
  writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// 觸發 Phase 0
// ---------------------------------------------------------------------------
function triggerPhase0(sprint) {
  const jql = `project = ${jiraProject} AND sprint in openSprints() AND statusCategory != Done`;
  const promptFileArg = args["prompt-file"] ? `--prompt-file "${args["prompt-file"]}"` : "";

  const cmd = [
    `node ${phase0Script}`,
    `--jira-project ${jiraProject}`,
    `--jira-url ${jiraUrl}`,
    `--ao-project ${aoProject}`,
    `--jql "${jql}"`,
    promptFileArg,
    dryRun ? "--dry-run" : "",
  ]
    .filter(Boolean)
    .join(" ");

  console.log(
    `[sprint-watcher] 🚀 觸發 Phase 0，sprint="${sprint.name}"（${sprint.issueCount} issues）`,
  );

  if (dryRun) {
    console.log(`[dry-run] ${cmd}`);
    return;
  }

  try {
    execSync(cmd, { stdio: "inherit", env: { ...process.env } });
    console.log("[sprint-watcher] ✓ Phase 0 完成");
  } catch (err) {
    console.error(`[sprint-watcher] ✗ Phase 0 執行失敗: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main poll cycle
// ---------------------------------------------------------------------------
async function poll() {
  let sprint;
  try {
    sprint = await getActiveSprint();
  } catch (err) {
    console.error(`[sprint-watcher] Jira 查詢失敗: ${err.message}`);
    return;
  }

  if (!sprint) {
    console.log("[sprint-watcher] 目前沒有 active sprint，等待中...");
    return;
  }

  console.log(`[sprint-watcher] active sprint: "${sprint.name}" (id=${sprint.id}, issues=${sprint.issueCount})`);

  const state = loadState();

  if (state.lastSprintId === sprint.id) {
    console.log(
      `[sprint-watcher] sprint 未變更，跳過（上次觸發：${state.triggeredAt ?? "從未"}）`,
    );
    return;
  }

  // 偵測到新 sprint
  console.log(
    `[sprint-watcher] 偵測到新 sprint: ${state.lastSprintName ?? "(無)"} → ${sprint.name}`,
  );

  triggerPhase0(sprint);

  saveState({
    lastSprintId:   sprint.id,
    lastSprintName: sprint.name,
    triggeredAt:    new Date().toISOString(),
    issueCount:     sprint.issueCount,
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------
console.log("[sprint-watcher] 啟動");
console.log(`  Jira project:  ${jiraProject}  (${jiraUrl})`);
console.log(`  AO project:    ${aoProject}`);
console.log(`  State file:    ${stateFile}`);
console.log(`  Poll interval: ${intervalMs / 1000}s`);
console.log(`  Dry-run:       ${dryRun}`);

async function loop() {
  try {
    await poll();
  } catch (err) {
    console.error(`[sprint-watcher] 未預期錯誤: ${err.message}`);
  }

  if (once) {
    console.log("[sprint-watcher] --once 模式，結束");
    return;
  }

  setTimeout(loop, intervalMs);
}

loop();
