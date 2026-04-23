#!/usr/bin/env node
// Phase 0: 從 Jira 讀取 issues，批量 spawn spec sessions
// 用法：node scripts/phase0-spawn-specs.mjs --jira-project MOPFREQ --jira-url https://... --ao-project paradise-soft
// 環境變數：JIRA_EMAIL, JIRA_API_TOKEN

import { readFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { parseArgs } from "node:util";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const { values: args } = parseArgs({
  options: {
    "jira-project": { type: "string" },
    "jira-url":     { type: "string" },
    "ao-project":   { type: "string" },
    "prompt-file":  { type: "string", default: "" },
    "jql":          { type: "string", default: "" },
    "dry-run":      { type: "boolean", default: false },
    "delay-ms":     { type: "string", default: "3000" },
  },
});

const jiraProject = args["jira-project"];
const jiraUrl     = args["jira-url"];
const aoProject   = args["ao-project"];
const dryRun      = args["dry-run"];
const delayMs     = parseInt(args["delay-ms"] ?? "3000", 10);

if (!jiraProject || !jiraUrl || !aoProject) {
  console.error(
    "Usage: node phase0-spawn-specs.mjs " +
    "--jira-project MOPFREQ --jira-url https://jira.example.com --ao-project paradise-soft",
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Jira auth
// ---------------------------------------------------------------------------
const email    = process.env.JIRA_EMAIL;
const apiToken = process.env.JIRA_API_TOKEN;

if (!email || !apiToken) {
  console.error("[phase0] 需要設定環境變數 JIRA_EMAIL 和 JIRA_API_TOKEN");
  process.exit(1);
}

const authHeader = "Basic " + Buffer.from(`${email}:${apiToken}`).toString("base64");

// ---------------------------------------------------------------------------
// Load spec agent prompt
// ---------------------------------------------------------------------------
function loadPrompt() {
  const candidates = [
    args["prompt-file"],
    resolve(process.cwd(), "prompts/spec-agent.md"),
    join(homedir(), "projects/agent-orchestrator-demo/prompts/spec-agent.md"),
  ].filter(Boolean);

  for (const p of candidates) {
    if (existsSync(p)) {
      const raw = readFileSync(p, "utf8");
      // 壓縮成單行傳給 --prompt（ao spawn 不接受多行）
      return raw.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  throw new Error(
    "找不到 spec-agent.md prompt 檔案。請用 --prompt-file 指定，或放在 prompts/spec-agent.md。",
  );
}

// ---------------------------------------------------------------------------
// Fetch Jira issues
// ---------------------------------------------------------------------------
async function fetchIssues() {
  const jql = args["jql"] ||
    `project = ${jiraProject} AND statusCategory != Done ORDER BY priority DESC`;
  const url =
    `${jiraUrl}/rest/api/2/search` +
    `?jql=${encodeURIComponent(jql)}&maxResults=50&fields=summary,status,issuetype`;

  const res = await fetch(url, {
    headers: { Authorization: authHeader, Accept: "application/json" },
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Jira API 錯誤 ${res.status}: ${body}`);
  }

  const data = await res.json();
  return data.issues.map((issue) => ({
    key:     issue.key,
    summary: issue.fields.summary,
    status:  issue.fields.status.name,
    type:    issue.fields.issuetype.name,
  }));
}

// ---------------------------------------------------------------------------
// Spawn a single spec session
// ---------------------------------------------------------------------------
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function spawnSpec(issueKey, prompt) {
  // 用單引號包 prompt，避免 shell 解析問題；超過 4096 字元則截斷並警告
  const trimmedPrompt = prompt.length > 4000 ? prompt.slice(0, 4000) : prompt;
  if (prompt.length > 4000) {
    console.warn(`[phase0] prompt 超過 4000 字元，已截斷`);
  }

  const escapedPrompt = trimmedPrompt.replace(/'/g, "'\\''");
  const cmd = `ao spawn ${issueKey} --session-type spec --prompt '${escapedPrompt}'`;

  console.log(`[phase0] spawning spec session for ${issueKey}...`);

  if (dryRun) {
    console.log(`[dry-run] ${cmd.slice(0, 120)}...`);
    return;
  }

  try {
    const output = execSync(cmd, {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
    });
    const sessionMatch = output.match(/SESSION=(\S+)/);
    const sessionId = sessionMatch?.[1] ?? "(unknown)";
    console.log(`[phase0] ✓ ${issueKey} → session ${sessionId}`);
  } catch (err) {
    console.error(`[phase0] ✗ ${issueKey} spawn 失敗: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const prompt = loadPrompt();
console.log(`[phase0] 已載入 spec prompt（${prompt.length} 字元）`);

let issues;
try {
  issues = await fetchIssues();
} catch (err) {
  console.error(`[phase0] 取得 Jira issues 失敗: ${err.message}`);
  process.exit(1);
}

console.log(`[phase0] 找到 ${issues.length} 個 issues（${jiraProject}）`);

if (issues.length === 0) {
  console.log("[phase0] 沒有 issue 需要處理，結束。");
  process.exit(0);
}

for (const issue of issues) {
  console.log(`  ${issue.key}: ${issue.summary} [${issue.status}]`);
}

if (dryRun) {
  console.log("[dry-run] 以上 issues 將以 spec session 形式 spawn（dry-run，不實際執行）");
  process.exit(0);
}

for (const issue of issues) {
  spawnSpec(issue.key, prompt);
  if (delayMs > 0) {
    await sleep(delayMs);
  }
}

console.log("[phase0] 完成 — 所有 spec sessions 已啟動");
