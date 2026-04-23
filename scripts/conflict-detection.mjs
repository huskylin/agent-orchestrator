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
    "specs-dir": { type: "string", default: "specs" },
    "tasks-dir": { type: "string", default: ".claude/tasks" },
    "dry-run": { type: "boolean", default: false },
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
      result[kvMatch[1]] = kvMatch[2].trim();
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

if (conflicts.length > 0) {
  console.error("[conflict-detection] FILE CONFLICTS DETECTED — cannot proceed:");
  for (const { a, b, overlap } of conflicts) {
    console.error(`  ${a} ↔ ${b}: ${overlap.join(", ")}`);
  }

  const reportPath = join(specsDir, "conflict-report.json");
  const report = {
    detectedAt: new Date().toISOString(),
    conflicts: conflicts.map(({ a, b, overlap }) => ({ a, b, overlap })),
    resolution:
      "請修改衝突 spec 的 files_to_touch，確保每個檔案只屬於一個 issue，" +
      "或在較後執行的 issue spec 加入 blocked_by 依賴關係讓其串行執行。",
  };
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.error(`[conflict-detection] 詳細報告已寫入 ${reportPath}`);
  process.exit(1);
}

console.log("[conflict-detection] no conflicts found");

writeTasks(buildWaves(specs));

console.log("[conflict-detection] done — tasks written to", tasksDir);
