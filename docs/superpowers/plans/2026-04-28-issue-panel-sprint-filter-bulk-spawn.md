# IssuePanel Sprint Filter + Bulk Spawn Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 IssuePanel 新增 Sprint filter 按鈕（只顯示 active sprint 的 issues）和全選 + 批量 spawn 功能。

**Architecture:** 在 `IssueFilters` 加 `sprint?: "active"` 欄位，Jira plugin 讀取 `boardId` config 後呼叫 Jira Agile API 取 active sprint ID 並加進 JQL。`/api/issues` route 透傳 `sprint` query param，IssuePanel 新增 `sprintOnly` 切換 state、`selectedIds: Set<string>` 選取 state、sequential bulk spawn（每次 spawn 前確認 active session 數 < 5）。

**Tech Stack:** TypeScript, React 19, Next.js 15, Vitest + @testing-library/react

---

## File Structure

| 檔案 | 改動 |
|------|------|
| `packages/core/src/types.ts` | 加 `sprint?: "active"` 到 `IssueFilters` |
| `packages/plugins/tracker-jira/src/index.ts` | 加 `boardId` config、`jiraAgileFetch` helper、`getActiveSprintId` helper、更新 `listIssues` |
| `packages/web/src/app/api/issues/route.ts` | 讀取 `?sprint=active` query param 並傳給 filters |
| `packages/web/src/components/IssuePanel.tsx` | sprint toggle、checkbox 選取、bulk spawn |
| `packages/web/src/app/globals.css` | 新增 toolbar、sprint toggle、select-all、checkbox、bulk spawn 按鈕的 CSS |
| `packages/web/src/components/__tests__/IssuePanel.test.tsx` | 新增 sprint filter + bulk spawn 測試 |

---

## Task 1: Core types — `sprint?: "active"`

**Files:**
- Modify: `packages/core/src/types.ts` (lines 695–700)

- [ ] **Step 1: Add sprint field to IssueFilters**

In `packages/core/src/types.ts`, find the `IssueFilters` interface (around line 695) and add the `sprint` field:

```typescript
export interface IssueFilters {
  state?: "open" | "closed" | "all";
  labels?: string[];
  assignee?: string;
  limit?: number;
  sprint?: "active";
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run from `packages/web`:
```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator
git add packages/core/src/types.ts
git commit -m "feat: add sprint field to IssueFilters"
```

---

## Task 2: Jira plugin — boardId config + active sprint JQL

**Files:**
- Modify: `packages/plugins/tracker-jira/src/index.ts`

Note: The tracker-jira package has no test infrastructure. Coverage is provided by the IssuePanel integration tests in Task 4.

- [ ] **Step 1: Add `boardId` to `JiraConfig`**

In `packages/plugins/tracker-jira/src/index.ts`, update the `JiraConfig` interface (around line 31):

```typescript
interface JiraConfig {
  baseUrl: string;
  email?: string;
  token?: string;
  project?: string;
  boardId?: number;
}
```

- [ ] **Step 2: Extract `boardId` in `getConfig()`**

Update the `getConfig` function (around line 70) to also extract `boardId`:

```typescript
function getConfig(project: ProjectConfig): JiraConfig {
  const tracker = project.tracker as JiraConfig & Record<string, unknown>;
  if (!tracker?.baseUrl) {
    throw new Error(
      "Jira tracker requires 'baseUrl' in tracker config (e.g. https://jira.yourcompany.com)",
    );
  }
  return {
    baseUrl: tracker.baseUrl.replace(/\/$/, ""),
    email: tracker.email as string | undefined,
    token: tracker.token as string | undefined,
    project: tracker.project as string | undefined,
    boardId: typeof tracker.boardId === "number" ? tracker.boardId : undefined,
  };
}
```

- [ ] **Step 3: Add `jiraAgileFetch` helper and `getActiveSprintId` function**

Add after the existing `jiraFetch` function (around line 121):

```typescript
async function jiraAgileFetch<T>(
  config: JiraConfig,
  path: string,
): Promise<T> {
  const url = `${config.baseUrl}/rest/agile/1.0${path}`;
  const res = await fetch(url, {
    headers: {
      "Authorization": makeAuthHeader(config),
      "Content-Type": "application/json",
      "Accept": "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira Agile API GET ${path} failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<T>;
}

async function getActiveSprintId(config: JiraConfig): Promise<number | null> {
  if (!config.boardId) return null;
  try {
    const result = await jiraAgileFetch<{ values: Array<{ id: number }> }>(
      config,
      `/board/${config.boardId}/sprint?state=active`,
    );
    return result.values[0]?.id ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Update `listIssues` to use sprint filter**

In the `listIssues` method (around line 213), add the sprint clause after the existing filter clauses, before building the final JQL string:

```typescript
async listIssues(filters: IssueFilters, project: ProjectConfig): Promise<Issue[]> {
  const config = getConfig(project);
  const projectKey = config.project;
  if (!projectKey) {
    throw new Error("Jira tracker requires 'project' key in tracker config (e.g. PROJ)");
  }

  const jqlParts: string[] = [`project = ${projectKey}`];

  if (filters.state === "closed") {
    jqlParts.push("statusCategory = Done");
  } else if (filters.state === "all") {
    // no status filter
  } else {
    // open by default
    jqlParts.push("statusCategory != Done");
  }

  if (filters.labels && filters.labels.length > 0) {
    const labelList = filters.labels.map((l) => `"${l}"`).join(", ");
    jqlParts.push(`labels in (${labelList})`);
  }

  if (filters.assignee) {
    jqlParts.push(`assignee = "${filters.assignee}"`);
  }

  if (filters.sprint === "active") {
    const sprintId = await getActiveSprintId(config);
    if (sprintId !== null) {
      jqlParts.push(`sprint = ${sprintId}`);
    }
  }

  const jql = jqlParts.join(" AND ") + " ORDER BY created DESC";
  const maxResults = filters.limit ?? 30;

  const result = await jiraFetch<JiraSearchResult>(
    config,
    `/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,description,status,labels,assignee,priority`,
  );

  return result.issues.map((issue) => mapJiraIssue(issue, config.baseUrl));
},
```

- [ ] **Step 5: Verify TypeScript compiles**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator
git add packages/plugins/tracker-jira/src/index.ts
git commit -m "feat: Jira plugin 支援 boardId config 和 active sprint JQL filter"
```

---

## Task 3: `/api/issues` route — `sprint` query param

**Files:**
- Modify: `packages/web/src/app/api/issues/route.ts` (around line 12–48)

- [ ] **Step 1: Read `sprint` query param and pass to filters**

Replace the GET handler's filter construction (around line 14–33) so it passes `sprint` to `listIssues`:

```typescript
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const state = (searchParams.get("state") ?? "open") as "open" | "closed" | "all";
  const label = searchParams.get("label") ?? undefined;
  const projectFilter = searchParams.get("project") ?? undefined;
  const sprint = searchParams.get("sprint");

  try {
    const { config, registry } = await getServices();
    const allIssues: Array<{ projectId: string; id: string; title: string; url: string; state: string; labels: string[] }> = [];

    for (const [projectId, project] of Object.entries(config.projects)) {
      if (projectFilter && projectId !== projectFilter) continue;
      if (!project.tracker?.plugin) continue;

      const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
      if (!tracker?.listIssues) continue;

      try {
        const issues = await tracker.listIssues(
          {
            state,
            labels: label ? [label] : undefined,
            limit: 50,
            ...(sprint === "active" && { sprint: "active" as const }),
          },
          project,
        );
        for (const issue of issues) {
          allIssues.push({ projectId, ...issue });
        }
      } catch {
        // Skip unavailable trackers
      }
    }

    return NextResponse.json({ issues: allIssues });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to fetch issues" },
      { status: 500 },
    );
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator
git add packages/web/src/app/api/issues/route.ts
git commit -m "feat: /api/issues 支援 sprint=active query param"
```

---

## Task 4: IssuePanel — sprint toggle + checkboxes + bulk spawn (TDD)

**Files:**
- Modify: `packages/web/src/components/__tests__/IssuePanel.test.tsx`
- Modify: `packages/web/src/components/IssuePanel.tsx`
- Modify: `packages/web/src/app/globals.css`

- [ ] **Step 1: Write failing tests**

Add the following new test cases to `packages/web/src/components/__tests__/IssuePanel.test.tsx` (append after the existing last test, before the final `}`):

```typescript
  it("shows '目前 Sprint' toggle button and re-fetches with sprint=active when clicked", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: ISSUES }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: [ISSUES[0]] }),
      } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);
    await waitFor(() => screen.getByText("WIN-1"));

    const sprintBtn = screen.getByRole("button", { name: "目前 Sprint" });
    expect(sprintBtn).toBeInTheDocument();

    fireEvent.click(sprintBtn);

    await waitFor(() => {
      const calls = vi.mocked(fetch).mock.calls.map((c) => c[0] as string);
      expect(calls.some((url) => url.includes("sprint=active"))).toBe(true);
    });
  });

  it("sprint toggle switches label to '所有 Issues' after click", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ issues: ISSUES }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ issues: ISSUES }) } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);
    await waitFor(() => screen.getByText("WIN-1"));

    fireEvent.click(screen.getByRole("button", { name: "目前 Sprint" }));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "所有 Issues" })).toBeInTheDocument();
    });
  });

  it("checking a row checkbox shows bulk spawn button", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: ISSUES }),
    } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);
    await waitFor(() => screen.getByText("WIN-1"));

    expect(screen.queryByRole("button", { name: /spawn 選取的/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("checkbox", { name: "選取 WIN-1" }));

    expect(screen.getByRole("button", { name: /spawn 選取的 \(1\)/i })).toBeInTheDocument();
  });

  it("select-all checkbox selects all issues", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: ISSUES }),
    } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);
    await waitFor(() => screen.getByText("WIN-1"));

    fireEvent.click(screen.getByRole("checkbox", { name: "全選" }));

    const checked = screen.getAllByRole("checkbox").filter(
      (cb) => (cb as HTMLInputElement).checked,
    );
    // 1 select-all + 2 issue row checkboxes = 3
    expect(checked).toHaveLength(3);
    expect(screen.getByRole("button", { name: /spawn 選取的 \(2\)/i })).toBeInTheDocument();
  });

  it("clicking select-all again deselects all", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: ISSUES }),
    } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);
    await waitFor(() => screen.getByText("WIN-1"));

    fireEvent.click(screen.getByRole("checkbox", { name: "全選" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "全選" }));

    const checked = screen.getAllByRole("checkbox").filter(
      (cb) => (cb as HTMLInputElement).checked,
    );
    expect(checked).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /spawn 選取的/i })).not.toBeInTheDocument();
  });

  it("bulk spawns all selected issues sequentially", async () => {
    const onSpawned = vi.fn();
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ issues: ISSUES }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: [] }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({}) } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={onSpawned} />);
    await waitFor(() => screen.getByText("WIN-1"));

    fireEvent.click(screen.getByRole("checkbox", { name: "全選" }));
    fireEvent.click(screen.getByRole("button", { name: /spawn 選取的/i }));

    await waitFor(() => {
      const spawnCalls = vi.mocked(fetch).mock.calls.filter(
        (c) => c[0] === "/api/spawn",
      );
      expect(spawnCalls).toHaveLength(2);
      expect(spawnCalls[0][1]).toMatchObject({
        body: JSON.stringify({ projectId: "paradise-soft", issueId: "WIN-1" }),
      });
      expect(spawnCalls[1][1]).toMatchObject({
        body: JSON.stringify({ projectId: "paradise-soft", issueId: "WIN-2" }),
      });
      expect(onSpawned).toHaveBeenCalledTimes(1);
    });
  });

  it("stops bulk spawn when 5 active sessions are running", async () => {
    const onSpawned = vi.fn();
    const activeSessions = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      status: "working",
    }));

    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ issues: ISSUES }) } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ sessions: activeSessions }),
      } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={onSpawned} />);
    await waitFor(() => screen.getByText("WIN-1"));

    fireEvent.click(screen.getByRole("checkbox", { name: "全選" }));
    fireEvent.click(screen.getByRole("button", { name: /spawn 選取的/i }));

    await waitFor(() => {
      const spawnCalls = vi.mocked(fetch).mock.calls.filter(
        (c) => c[0] === "/api/spawn",
      );
      expect(spawnCalls).toHaveLength(0);
      expect(onSpawned).not.toHaveBeenCalled();
    });
  });

  it("individual Spawn buttons are disabled during bulk spawn", async () => {
    let resolveBulkSpawn!: (v: Response) => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ issues: ISSUES }) } as Response)
      .mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: [] }) } as Response)
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveBulkSpawn = resolve;
        }),
      );

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);
    await waitFor(() => screen.getByText("WIN-1"));

    fireEvent.click(screen.getByRole("checkbox", { name: "選取 WIN-1" }));
    fireEvent.click(screen.getByRole("button", { name: /spawn 選取的/i }));

    await waitFor(() => {
      const spawnButtons = screen.getAllByRole("button", { name: /^spawn win/i });
      expect(spawnButtons.every((btn) => btn.hasAttribute("disabled"))).toBe(true);
    });

    resolveBulkSpawn({ ok: true, json: async () => ({}) } as Response);
  });
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web && npm test -- --reporter=verbose src/components/__tests__/IssuePanel.test.tsx
```
Expected: the new tests FAIL (component doesn't have sprint toggle, checkboxes, or bulk spawn yet). Existing 7 tests should still PASS.

- [ ] **Step 3: Implement the new IssuePanel component**

Replace the entire content of `packages/web/src/components/IssuePanel.tsx` with:

```tsx
"use client";

import { useState, useEffect } from "react";
import { useToast } from "./Toast";

interface Issue {
  id: string;
  title: string;
  url: string;
  projectId: string;
  state: string;
  labels: string[];
}

interface IssuePanelProps {
  projectId: string;
  onSpawned: () => void;
}

const TERMINAL_STATUSES = new Set([
  "killed",
  "terminated",
  "done",
  "cleanup",
  "errored",
  "merged",
]);

export function IssuePanel({ projectId, onSpawned }: IssuePanelProps) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState<string | null>(null);
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const [sprintOnly, setSprintOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkSpawning, setIsBulkSpawning] = useState(false);
  const { showToast } = useToast();

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSelectedIds(new Set());
    const sprintParam = sprintOnly ? "&sprint=active" : "";
    fetch(
      `/api/issues?state=open&project=${encodeURIComponent(projectId)}${sprintParam}`,
      { signal: controller.signal },
    )
      .then((res) => res.json() as Promise<{ issues?: Issue[]; error?: string }>)
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setIssues(data.issues ?? []);
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setError(err instanceof Error ? err.message : "Failed to load issues");
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [projectId, sprintOnly]);

  const handleSpawn = async (issue: Issue) => {
    setSpawning(issue.id);
    setSpawnErrors(({ [issue.id]: _ignored, ...rest }) => rest);
    try {
      const res = await fetch("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, issueId: issue.id }),
      });
      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Failed to spawn session");
      }
      showToast(`${issue.id} spawned`, "success");
      onSpawned();
    } catch (err) {
      setSpawnErrors((prev) => ({
        ...prev,
        [issue.id]: err instanceof Error ? err.message : "Failed to spawn",
      }));
    } finally {
      setSpawning(null);
    }
  };

  const handleSelectAll = () => {
    if (selectedIds.size === issues.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(issues.map((i) => i.id)));
    }
  };

  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const handleBulkSpawn = async () => {
    setIsBulkSpawning(true);
    let spawnedCount = 0;
    const idsToSpawn = [...selectedIds];

    for (const id of idsToSpawn) {
      try {
        const sessionsRes = await fetch("/api/sessions");
        const sessionsData = (await sessionsRes.json()) as {
          sessions?: Array<{ status: string }>;
        };
        const activeCount = (sessionsData.sessions ?? []).filter(
          (s) => !TERMINAL_STATUSES.has(s.status),
        ).length;
        if (activeCount >= 5) {
          showToast(`已達上限，已 spawn ${spawnedCount} 個`, "info");
          break;
        }
      } catch {
        // If session check fails, proceed optimistically
      }

      try {
        const res = await fetch("/api/spawn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId, issueId: id }),
        });
        if (!res.ok) {
          const data = (await res.json()) as { error?: string };
          setSpawnErrors((prev) => ({
            ...prev,
            [id]: data.error ?? "Failed to spawn",
          }));
        } else {
          spawnedCount++;
        }
      } catch (err) {
        setSpawnErrors((prev) => ({
          ...prev,
          [id]: err instanceof Error ? err.message : "Failed to spawn",
        }));
      }
    }

    setIsBulkSpawning(false);
    if (spawnedCount > 0) {
      showToast(`已 spawn ${spawnedCount} 個 issue`, "success");
      onSpawned();
    }
  };

  if (loading) {
    return (
      <div className="issue-panel">
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="issue-panel__row issue-panel__row--skeleton">
            <div className="issue-panel__skeleton-id" />
            <div className="issue-panel__skeleton-title" />
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="issue-panel issue-panel--empty">
        <p className="issue-panel__error">{error}</p>
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="issue-panel issue-panel--empty">
        <p className="issue-panel__empty">No open issues found.</p>
      </div>
    );
  }

  const allSelected = issues.length > 0 && selectedIds.size === issues.length;

  return (
    <div className="issue-panel">
      <div className="issue-panel__toolbar">
        <button
          type="button"
          className="issue-panel__sprint-toggle"
          onClick={() => setSprintOnly((v) => !v)}
        >
          {sprintOnly ? "所有 Issues" : "目前 Sprint"}
        </button>
        <label className="issue-panel__select-all">
          <input
            type="checkbox"
            checked={allSelected}
            onChange={handleSelectAll}
            aria-label="全選"
          />
          全選 ({selectedIds.size})
        </label>
        {selectedIds.size > 0 && (
          <button
            type="button"
            className="issue-panel__bulk-spawn"
            onClick={() => void handleBulkSpawn()}
            disabled={isBulkSpawning}
          >
            {isBulkSpawning ? "Spawning…" : `Spawn 選取的 (${selectedIds.size})`}
          </button>
        )}
      </div>
      {issues.map((issue) => (
        <div key={issue.id} className="issue-panel__row">
          <input
            type="checkbox"
            className="issue-panel__checkbox"
            checked={selectedIds.has(issue.id)}
            onChange={() => handleToggleSelect(issue.id)}
            aria-label={`選取 ${issue.id}`}
          />
          <span className="issue-panel__id">{issue.id}</span>
          <span className="issue-panel__title" title={issue.title}>
            {issue.title}
          </span>
          <div className="issue-panel__actions">
            <a
              href={issue.url}
              target="_blank"
              rel="noreferrer"
              className="issue-panel__link"
              aria-label={`Open ${issue.id} in tracker`}
            >
              ↗
            </a>
            <button
              type="button"
              className="issue-panel__spawn"
              aria-label={`Spawn ${issue.id}`}
              onClick={() => void handleSpawn(issue)}
              disabled={spawning === issue.id || isBulkSpawning}
            >
              {spawning === issue.id ? "…" : "Spawn"}
            </button>
          </div>
          {spawnErrors[issue.id] ? (
            <p className="issue-panel__spawn-error">{spawnErrors[issue.id]}</p>
          ) : null}
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Add CSS for toolbar and new elements**

Append to the end of `packages/web/src/app/globals.css` (after the last `.issue-panel__skeleton-title` rule):

```css
.issue-panel__toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.375rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
  flex-wrap: wrap;
}

.issue-panel__sprint-toggle {
  font-size: 0.6875rem;
  font-weight: 500;
  padding: 0 0.5rem;
  height: 22px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background 100ms ease;
}

.issue-panel__sprint-toggle:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.issue-panel__select-all {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  cursor: pointer;
  user-select: none;
}

.issue-panel__bulk-spawn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 0.625rem;
  font-size: 0.6875rem;
  font-weight: 500;
  border-radius: var(--radius-sm);
  background: var(--color-accent-blue);
  color: #fff;
  border: none;
  cursor: pointer;
  transition: opacity 100ms ease;
}

.issue-panel__bulk-spawn:hover {
  opacity: 0.85;
}

.issue-panel__bulk-spawn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.issue-panel__checkbox {
  flex-shrink: 0;
  cursor: pointer;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web && npm test -- --reporter=verbose src/components/__tests__/IssuePanel.test.tsx
```
Expected: all tests PASS (both existing 7 and new 8 = 15 total).

- [ ] **Step 6: Run full test suite**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web && npm test
```
Expected: all tests pass, no regressions.

- [ ] **Step 7: TypeScript check**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web && npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator
git add packages/web/src/components/IssuePanel.tsx \
        packages/web/src/app/globals.css \
        packages/web/src/components/__tests__/IssuePanel.test.tsx
git commit -m "feat: IssuePanel 新增 sprint filter、checkbox 選取、批量 spawn 功能"
```

---

## Config note: add `boardId` to `agent-orchestrator.yaml`

After implementation, the user needs to add `boardId` to their tracker config:

```yaml
tracker:
  plugin: jira
  baseUrl: https://jira.paradise-soft.com.tw
  project: WIN
  boardId: 359   # ← 新增此行
```

Sprint filter 按鈕在沒有 `boardId` 的情況下仍可點擊，但不會過濾 sprint（`getActiveSprintId` 回傳 null，JQL 不加 sprint 條件）。
