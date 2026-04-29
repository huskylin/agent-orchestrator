#!/usr/bin/env node
// Conflict detection for spec-phase pipeline.
// Reads all SDD files under specs/, compares files_to_touch across issues,
// and outputs .claude/tasks/*.json when no conflicts are found.
//
// Triggered by: all-complete reaction when all sessions are sessionType="spec"
// Usage: node scripts/conflict-detection.mjs [--specs-dir <path>] [--tasks-dir <path>]

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const { values: args } = parseArgs({
  options: {
    "specs-dir":  { type: "string", default: "specs" },
    "tasks-dir":  { type: "string", default: ".claude/tasks" },
    "ao-url":     { type: "string", default: "http://localhost:3000" },
    "project":    { type: "string", default: "" },
    "dry-run":    { type: "boolean", default: false },
  },
});

const specsDir = resolve(process.cwd(), args["specs-dir"]);
const tasksDir = resolve(process.cwd(), args["tasks-dir"]);
const dryRun = args["dry-run"];

// ---------------------------------------------------------------------------
// Parse SDD YAML front-matter
// Expects files like specs/PROJ-42.md with a --- delimited YAML header
// ---------------------------------------------------------------------------

function parseFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  const result = {};

  for (const line of yaml.split("\n")) {
    // Simple key: value
    const kvMatch = line.match(/^(\w[\w_]*)\s*:\s*(.+)$/);
    if (kvMatch) {
      const val = kvMatch[2].trim();
      // Handle inline empty array literal: key: []
      result[kvMatch[1]] = val === "[]" ? [] : val;
      continue;
    }

    // List item under files_to_touch / blocked_by
    const listMatch = line.match(/^\s+-\s+(.+)$/);
    if (listMatch) {
      const lastKey = Object.keys(result).at(-1);
      if (lastKey) {
        if (!Array.isArray(result[lastKey])) result[lastKey] = [];
        result[lastKey].push(listMatch[1].trim());
      }
      continue;
    }

    // Key with no inline value (array follows)
    const keyOnly = line.match(/^(\w[\w_]*)\s*:\s*$/);
    if (keyOnly) {
      result[keyOnly[1]] = [];
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Load all SDD files
// ---------------------------------------------------------------------------

function loadSpecs(dir) {
  let files;
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md"));
  } catch {
    console.error(`[conflict-detection] specs dir not found: ${dir}`);
    process.exit(1);
  }

  const specs = [];
  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8");
    const fm = parseFrontMatter(content);
    if (!fm) {
      console.warn(`[conflict-detection] skipping ${file}: no front-matter`);
      continue;
    }
    specs.push({ file: basename(file, ".md"), ...fm });
  }
  return specs;
}

// ---------------------------------------------------------------------------
// Detect file conflicts (set intersection across all pairs)
// ---------------------------------------------------------------------------

function detectConflicts(specs) {
  const conflicts = [];

  for (let i = 0; i < specs.length; i++) {
    for (let j = i + 1; j < specs.length; j++) {
      const a = specs[i];
      const b = specs[j];

      const aFiles = new Set(a.files_to_touch ?? []);
      const bFiles = new Set(b.files_to_touch ?? []);
      const overlap = [...aFiles].filter((f) => bFiles.has(f));

      if (overlap.length > 0) {
        conflicts.push({ a: a.task_id ?? a.file, b: b.task_id ?? b.file, overlap });
      }
    }
  }

  return conflicts;
}

// ---------------------------------------------------------------------------
// Build wave ordering from blocked_by dependencies
// ---------------------------------------------------------------------------

function buildWaves(specs) {
  const idToSpec = Object.fromEntries(
    specs.map((s) => [s.task_id ?? s.file, s]),
  );

  const waves = [];
  const assigned = new Set();

  while (assigned.size < specs.length) {
    const wave = specs.filter((s) => {
      const id = s.task_id ?? s.file;
      if (assigned.has(id)) return false;
      const deps = s.blocked_by ?? [];
      return deps.every((dep) => assigned.has(dep));
    });

    if (wave.length === 0) {
      // Remaining specs have unresolvable dependencies (circular or missing)
      const remaining = specs
        .filter((s) => !assigned.has(s.task_id ?? s.file))
        .map((s) => s.task_id ?? s.file);
      const cyclePath = join(specsDir, "cycle-report.json");
      writeFileSync(cyclePath, JSON.stringify({
        detectedAt: new Date().toISOString(),
        affectedTasks: remaining,
        resolution:
          "存在循環依賴或無法解析的 blocked_by，請人工修正 spec 的 blocked_by 欄位，確保依賴關係形成有向無環圖（DAG）。",
      }, null, 2) + "\n");
      console.error(`[conflict-detection] circular/unresolvable deps: ${remaining.join(", ")}`);
      console.error(`[conflict-detection] 詳細報告已寫入 ${cyclePath}`);
      process.exit(2);
    }

    waves.push(wave);
    for (const s of wave) assigned.add(s.task_id ?? s.file);
  }

  return waves;
}

// ---------------------------------------------------------------------------
// Write .claude/tasks/*.json
// ---------------------------------------------------------------------------

function writeTasks(waves) {
  mkdirSync(tasksDir, { recursive: true });

  let taskId = 1;
  const idMap = {}; // spec task_id → numeric task id

  // First pass: assign numeric IDs
  for (const wave of waves) {
    for (const spec of wave) {
      idMap[spec.task_id ?? spec.file] = String(taskId++);
    }
  }

  // Second pass: write JSON files
  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    for (const spec of waves[waveIdx]) {
      const id = idMap[spec.task_id ?? spec.file];
      const blockedBy = (spec.blocked_by ?? []).map((dep) => idMap[dep]).filter(Boolean);
      const blocks = Object.entries(idMap)
        .filter(([specId]) => {
          const s = specs.find((x) => (x.task_id ?? x.file) === specId);
          return (s?.blocked_by ?? []).includes(spec.task_id ?? spec.file);
        })
        .map(([, numId]) => numId);

      const task = {
        id,
        subject: spec.title ?? spec.task_id ?? spec.file,
        description: `See specs/${spec.file}.md`,
        status: "pending",
        blocks,
        blockedBy,
        owner: "",
        metadata: {
          wave: String(waveIdx + 1),
          jira_id: spec.task_id ?? "",
          spec_file: `specs/${spec.file}.md`,
          files_to_touch: spec.files_to_touch ?? [],
        },
      };

      const outPath = join(tasksDir, `${id}.json`);
      if (dryRun) {
        console.log(`[dry-run] would write ${outPath}:`);
        console.log(JSON.stringify(task, null, 2));
      } else {
        writeFileSync(outPath, JSON.stringify(task, null, 2) + "\n");
        console.log(`[conflict-detection] wrote ${outPath} (wave ${waveIdx + 1})`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const specs = loadSpecs(specsDir);

if (specs.length === 0) {
  console.error("[conflict-detection] no SDD files found in", specsDir);
  process.exit(1);
}

console.log(`[conflict-detection] loaded ${specs.length} specs`);

const conflicts = detectConflicts(specs);

async function postIssueComment(issue, body) {
  if (!issue || !args["project"] || dryRun) return;
  try {
    const res = await fetch(
      `${args["ao-url"].replace(/\/$/, "")}/api/issues/${encodeURIComponent(issue)}/comment`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: args["project"], body }),
      },
    );
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.warn(`[conflict-detection] comment failed for ${issue}: ${data.error ?? res.status}`);
    }
  } catch (err) {
    console.warn(`[conflict-detection] comment failed for ${issue}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Auto-serialise overlapping specs into chains via implicit blocked_by.
// Connected components of the overlap graph are sorted by task_id ascending,
// and each subsequent spec gains an implicit blocked_by on its predecessor —
// so wave-monitor will run them sequentially without losing parallelism for
// non-overlapping groups.
// ---------------------------------------------------------------------------
function autoSerialiseConflicts(specs, conflicts) {
  if (conflicts.length === 0) return { autoOrder: [], affectedSpecs: [] };

  const idOf = (s) => s.task_id ?? s.file;
  const specById = new Map(specs.map((s) => [idOf(s), s]));

  // Union-find over conflict pairs to get connected components.
  const parent = new Map();
  for (const id of specById.keys()) parent.set(id, id);
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const { a, b } of conflicts) union(a, b);

  // Group spec ids by root.
  const groups = new Map();
  for (const id of specById.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(id);
  }

  const autoOrder = [];
  const affectedSpecs = new Set();

  for (const [, members] of groups) {
    if (members.length < 2) continue;
    // Deterministic sort: task_id ascending (numeric-aware).
    members.sort((a, b) => {
      const numA = a.match(/\d+/);
      const numB = b.match(/\d+/);
      if (numA && numB) {
        const cmp = parseInt(numA[0], 10) - parseInt(numB[0], 10);
        if (cmp !== 0) return cmp;
      }
      return a.localeCompare(b);
    });

    autoOrder.push(members);
    for (let i = 1; i < members.length; i++) {
      const spec = specById.get(members[i]);
      const predecessor = members[i - 1];
      const existing = spec.blocked_by ?? [];
      if (!existing.includes(predecessor)) {
        spec.blocked_by = [...existing, predecessor];
      }
      affectedSpecs.add(members[i]);
    }
  }

  return { autoOrder, affectedSpecs: [...affectedSpecs] };
}

const { autoOrder } = autoSerialiseConflicts(specs, conflicts);

// Always write conflict-report.json for visibility (even when auto-resolved).
if (conflicts.length > 0) {
  const reportPath = join(specsDir, "conflict-report.json");
  const report = {
    detectedAt: new Date().toISOString(),
    conflicts: conflicts.map(({ a, b, overlap }) => ({ a, b, overlap })),
    autoSerialisation: autoOrder.map((chain) => ({
      chain,
      note: "issues auto-serialised by file overlap; ordered by ascending issue id",
    })),
    resolution:
      "重疊的檔案已自動串接成 wave chain。若需要不同順序，請手動編輯 spec 的 blocked_by 並重跑 conflict-detection.mjs。",
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.warn("[conflict-detection] file overlaps detected — auto-serialised into chains:");
  for (const chain of autoOrder) {
    console.warn(`  ${chain.join(" → ")}`);
  }
  console.warn(`[conflict-detection] audit log written to ${reportPath}`);
}

const waves = buildWaves(specs);
writeTasks(waves);

// Mirror wave assignment + auto-serialisation info to tracker
const autoChainByIssue = new Map();
for (const chain of autoOrder) {
  for (const issue of chain) autoChainByIssue.set(issue, chain);
}

for (let i = 0; i < waves.length; i++) {
  for (const spec of waves[i]) {
    const issue = spec.task_id;
    let body = `[AO] 📋 Queued in Wave ${i + 1} (${waves[i].length} issue${waves[i].length === 1 ? "" : "s"} in this wave)`;
    const chain = autoChainByIssue.get(issue);
    if (chain) {
      body += `\nAuto-serialised due to file overlap: ${chain.join(" → ")}`;
    }
    await postIssueComment(issue, body);
  }
}

console.log(
  `[conflict-detection] done — ${specs.length} specs, ${waves.length} wave(s) written to ${tasksDir}`,
);
