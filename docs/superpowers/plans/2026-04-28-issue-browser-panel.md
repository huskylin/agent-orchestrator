# Issue Browser Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 dashboard 主內容區新增 Issue Browser Panel，讓使用者切換顯示 Jira open issues 並直接從 dashboard spawn agent session。

**Architecture:** 新增 `IssuePanel.tsx` 元件，mount 時 fetch `/api/issues`，列出 issues 並提供 Spawn 按鈕。`Dashboard.tsx` 加一個 `showIssues` boolean state 和 header toggle button，主內容區依 state 切換顯示 Kanban 或 IssuePanel。CSS 樣式寫入 `globals.css`。

**Tech Stack:** React 19, Next.js 15, Tailwind CSS v4 (透過 CSS 變數), Vitest + @testing-library/react

---

## File Map

| 動作 | 路徑 | 說明 |
|------|------|------|
| 新增 | `packages/web/src/components/IssuePanel.tsx` | Issue Browser 主元件 |
| 新增 | `packages/web/src/components/__tests__/IssuePanel.test.tsx` | IssuePanel 單元測試 |
| 新增 | `packages/web/src/components/__tests__/Dashboard.issueBrowser.test.tsx` | Toggle 整合測試 |
| 修改 | `packages/web/src/components/Dashboard.tsx` | +state, +toggle button, +條件渲染 |
| 修改 | `packages/web/src/app/globals.css` | IssuePanel CSS 樣式 |

---

## Task 1: IssuePanel 元件（TDD）

**Files:**
- Create: `packages/web/src/components/IssuePanel.tsx`
- Create: `packages/web/src/components/__tests__/IssuePanel.test.tsx`

- [ ] **Step 1: 寫失敗測試**

建立 `packages/web/src/components/__tests__/IssuePanel.test.tsx`：

```tsx
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { IssuePanel } from "../IssuePanel";
import { ToastProvider } from "../Toast";

function renderWithToast(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

beforeEach(() => {
  global.fetch = vi.fn();
});

const ISSUES = [
  { projectId: "paradise-soft", id: "WIN-1", title: "Fix login bug", url: "https://jira.example.com/WIN-1", state: "open", labels: [] },
  { projectId: "paradise-soft", id: "WIN-2", title: "Add search bar", url: "https://jira.example.com/WIN-2", state: "open", labels: [] },
];

describe("IssuePanel", () => {
  it("shows loading skeleton then renders issue list", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: ISSUES }),
    } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);

    // loading state: skeleton rows visible initially (no issue IDs yet)
    expect(screen.queryByText("WIN-1")).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText("WIN-1")).toBeInTheDocument();
    });
    expect(screen.getByText("Fix login bug")).toBeInTheDocument();
    expect(screen.getByText("WIN-2")).toBeInTheDocument();
    expect(screen.getByText("Add search bar")).toBeInTheDocument();
  });

  it("shows error message when fetch fails", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("Network error"));

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("Network error")).toBeInTheDocument();
    });
  });

  it("shows empty state when no issues", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: [] }),
    } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText("No open issues found.")).toBeInTheDocument();
    });
  });

  it("renders Jira link with target=_blank", async () => {
    vi.mocked(fetch).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ issues: ISSUES }),
    } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);

    await waitFor(() => screen.getByText("WIN-1"));
    const links = screen.getAllByRole("link");
    expect(links[0]).toHaveAttribute("href", "https://jira.example.com/WIN-1");
    expect(links[0]).toHaveAttribute("target", "_blank");
  });

  it("calls /api/spawn and invokes onSpawned on success", async () => {
    const onSpawned = vi.fn();
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: ISSUES }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ session: { id: "s1" } }),
      } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={onSpawned} />);
    await waitFor(() => screen.getByText("WIN-1"));

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn" })[0]);

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith("/api/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId: "paradise-soft", issueId: "WIN-1" }),
      });
      expect(onSpawned).toHaveBeenCalledTimes(1);
    });
  });

  it("shows inline error when spawn fails", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: ISSUES }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        json: async () => ({ error: "Session limit reached" }),
      } as Response);

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);
    await waitFor(() => screen.getByText("WIN-1"));

    fireEvent.click(screen.getAllByRole("button", { name: "Spawn" })[0]);

    await waitFor(() => {
      expect(screen.getByText("Session limit reached")).toBeInTheDocument();
    });
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web
npx vitest run src/components/__tests__/IssuePanel.test.tsx
```

預期：`FAIL — Cannot find module '../IssuePanel'`

- [ ] **Step 3: 實作 IssuePanel.tsx**

建立 `packages/web/src/components/IssuePanel.tsx`：

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

export function IssuePanel({ projectId, onSpawned }: IssuePanelProps) {
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [spawning, setSpawning] = useState<string | null>(null);
  const [spawnErrors, setSpawnErrors] = useState<Record<string, string>>({});
  const { showToast } = useToast();

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/issues?state=open&project=${encodeURIComponent(projectId)}`)
      .then((res) => res.json() as Promise<{ issues?: Issue[]; error?: string }>)
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setIssues(data.issues ?? []);
      })
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to load issues");
      })
      .finally(() => setLoading(false));
  }, [projectId]);

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

  return (
    <div className="issue-panel">
      {issues.map((issue) => (
        <div key={issue.id} className="issue-panel__row">
          <span className="issue-panel__id">{issue.id}</span>
          <span className="issue-panel__title" title={issue.title}>{issue.title}</span>
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
              aria-label="Spawn"
              onClick={() => void handleSpawn(issue)}
              disabled={spawning === issue.id}
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

- [ ] **Step 4: 執行測試確認通過**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web
npx vitest run src/components/__tests__/IssuePanel.test.tsx
```

預期：`PASS` — 6 tests passed

- [ ] **Step 5: Commit**

```bash
git -C /Users/hank_y_lin/projects/agent-orchestrator add \
  packages/web/src/components/IssuePanel.tsx \
  packages/web/src/components/__tests__/IssuePanel.test.tsx
git -C /Users/hank_y_lin/projects/agent-orchestrator commit -m "feat: add IssuePanel component"
```

---

## Task 2: IssuePanel CSS 樣式

**Files:**
- Modify: `packages/web/src/app/globals.css`

- [ ] **Step 1: 在 globals.css 末尾加入樣式**

在 `packages/web/src/app/globals.css` 檔案最後加入以下內容：

```css
/* ── Issue Browser Panel ─────────────────────────────────────── */
.issue-panel {
  padding: 0.5rem 0;
}

.issue-panel__row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--color-border-subtle);
}

.issue-panel__row:hover {
  background: var(--color-bg-elevated);
}

.issue-panel__id {
  font-family: var(--font-mono);
  font-size: 0.6875rem;
  color: var(--color-text-tertiary);
  flex-shrink: 0;
  min-width: 5.5rem;
}

.issue-panel__title {
  flex: 1;
  font-size: 0.8125rem;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.issue-panel__actions {
  display: flex;
  align-items: center;
  gap: 0.375rem;
  flex-shrink: 0;
}

.issue-panel__link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  text-decoration: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
  line-height: 1;
}

.issue-panel__link:hover {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
}

.issue-panel__spawn {
  display: inline-flex;
  align-items: center;
  height: 24px;
  padding: 0 0.5rem;
  font-size: 0.6875rem;
  font-weight: 500;
  border-radius: var(--radius-sm);
  background: var(--color-accent-blue);
  color: #fff;
  border: none;
  cursor: pointer;
  transition: opacity 100ms ease;
}

.issue-panel__spawn:hover {
  opacity: 0.85;
}

.issue-panel__spawn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.issue-panel__spawn-error {
  font-size: 0.6875rem;
  color: var(--color-status-error);
  margin: 0;
  padding: 0 1rem 0.375rem;
}

.issue-panel--empty {
  padding: 3rem 1rem;
  text-align: center;
}

.issue-panel__error {
  color: var(--color-status-error);
  font-size: 0.8125rem;
  margin: 0;
}

.issue-panel__empty {
  color: var(--color-text-muted);
  font-size: 0.8125rem;
  margin: 0;
}

/* Skeleton rows */
.issue-panel__row--skeleton {
  pointer-events: none;
}

.issue-panel__skeleton-id {
  height: 0.625rem;
  width: 4.5rem;
  border-radius: var(--radius-sm);
  background: var(--color-bg-elevated);
  animation: pulse 1.5s ease-in-out infinite;
  flex-shrink: 0;
}

.issue-panel__skeleton-title {
  height: 0.625rem;
  flex: 1;
  border-radius: var(--radius-sm);
  background: var(--color-bg-elevated);
  animation: pulse 1.5s ease-in-out infinite;
}
```

- [ ] **Step 2: Commit**

```bash
git -C /Users/hank_y_lin/projects/agent-orchestrator add packages/web/src/app/globals.css
git -C /Users/hank_y_lin/projects/agent-orchestrator commit -m "feat: add IssuePanel CSS styles"
```

---

## Task 3: Dashboard.tsx — Toggle + 條件渲染

**Files:**
- Create: `packages/web/src/components/__tests__/Dashboard.issueBrowser.test.tsx`
- Modify: `packages/web/src/components/Dashboard.tsx`

- [ ] **Step 1: 寫失敗測試**

建立 `packages/web/src/components/__tests__/Dashboard.issueBrowser.test.tsx`：

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  const eventSourceMock = { onmessage: null, onerror: null, close: vi.fn() };
  global.EventSource = Object.assign(() => eventSourceMock, {
    CONNECTING: 0, OPEN: 1, CLOSED: 2,
  }) as unknown as typeof EventSource;
  global.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ issues: [] }),
  } as Response);
});

describe("Dashboard Issue Browser toggle", () => {
  it("shows Issues toggle button in single-project view", () => {
    render(
      <Dashboard
        initialSessions={[]}
        projectId="paradise-soft"
        projects={[{ id: "paradise-soft", name: "paradise-soft" }]}
      />,
    );
    expect(screen.getByRole("button", { name: /issues/i })).toBeInTheDocument();
  });

  it("does not show Issues button in all-projects view", () => {
    render(
      <Dashboard
        initialSessions={[]}
        projects={[
          { id: "p1", name: "Project 1" },
          { id: "p2", name: "Project 2" },
        ]}
      />,
    );
    expect(screen.queryByRole("button", { name: /issues/i })).not.toBeInTheDocument();
  });

  it("switches to Issues panel when toggle clicked", async () => {
    render(
      <Dashboard
        initialSessions={[]}
        projectId="paradise-soft"
        projects={[{ id: "paradise-soft", name: "paradise-soft" }]}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /issues/i }));

    await waitFor(() => {
      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining("/api/issues"),
      );
    });
  });

  it("switches back to Sessions when toggle clicked again", async () => {
    render(
      <Dashboard
        initialSessions={[]}
        projectId="paradise-soft"
        projects={[{ id: "paradise-soft", name: "paradise-soft" }]}
      />,
    );

    const toggle = screen.getByRole("button", { name: /issues/i });
    fireEvent.click(toggle);

    await waitFor(() => expect(fetch).toHaveBeenCalled());

    // Button label changes to "Sessions"
    const sessionsToggle = screen.getByRole("button", { name: /sessions/i });
    fireEvent.click(sessionsToggle);

    // No issue panel fetch again (issues unmounted)
    expect(screen.queryByRole("button", { name: /sessions/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /issues/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 執行測試確認失敗**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web
npx vitest run src/components/__tests__/Dashboard.issueBrowser.test.tsx
```

預期：`FAIL — Expected button with name "issues" to be in document`

- [ ] **Step 3: 修改 Dashboard.tsx**

**3a. 在 import 區最後一行之後加入 IssuePanel import（`packages/web/src/components/Dashboard.tsx` 第 27 行之後）：**

找到這行：
```typescript
import { projectDashboardPath, projectSessionPath } from "@/lib/routes";
```
在其後加入：
```typescript
import { IssuePanel } from "./IssuePanel";
```

**3b. 在 state 宣告區（第 178 行附近）加入 showIssues state。**

找到這段：
```typescript
  const [doneExpanded, setDoneExpanded] = useState(false);
```
在其後加入：
```typescript
  const [showIssues, setShowIssues] = useState(false);
```

**3c. 在 header `__actions` div 內，Orchestrator 按鈕之前加入 toggle button（第 507-557 行附近）。**

找到這段：
```tsx
            <div className="dashboard-app-header__actions">
              {!allProjectsView && orchestratorHref ? (
```
改成：
```tsx
            <div className="dashboard-app-header__actions">
              {!allProjectsView && projectId ? (
                <button
                  type="button"
                  className="dashboard-app-btn"
                  aria-label={showIssues ? "Sessions" : "Issues"}
                  onClick={() => setShowIssues((v) => !v)}
                >
                  {showIssues ? "Sessions" : "Issues"}
                </button>
              ) : null}
              {!allProjectsView && orchestratorHref ? (
```

**3d. 在主內容區，`!allProjectsView && hasAnySessions` Kanban 區塊之前加入 IssuePanel 渲染（第 635 行附近）。**

找到這段：
```tsx
                {!allProjectsView && hasAnySessions && (
                  <div className="kanban-board-wrap">
```
在其前面加入：
```tsx
                {!allProjectsView && showIssues && projectId ? (
                  <IssuePanel
                    projectId={projectId}
                    onSpawned={() => setShowIssues(false)}
                  />
                ) : null}

```

**3e. 將 Kanban、EmptyState、Done bar 用 `!showIssues` 包起來，避免在 Issues 模式下渲染。**

找到這段：
```tsx
                {!allProjectsView && hasAnySessions && (
                  <div className="kanban-board-wrap">
                    <div className="kanban-board">
```
改成：
```tsx
                {!allProjectsView && !showIssues && hasAnySessions && (
                  <div className="kanban-board-wrap">
                    <div className="kanban-board">
```

找到這段：
```tsx
                {showEmptyState ? (
```
改成：
```tsx
                {showEmptyState && !showIssues ? (
```

找到這段：
```tsx
                {!allProjectsView && grouped.done.length > 0 && (
```
改成：
```tsx
                {!allProjectsView && !showIssues && grouped.done.length > 0 && (
```

- [ ] **Step 4: 執行測試確認通過**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web
npx vitest run src/components/__tests__/Dashboard.issueBrowser.test.tsx
```

預期：`PASS` — 4 tests passed

- [ ] **Step 5: 執行全部測試確認無回歸**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web
npx vitest run
```

預期：所有既有測試通過，無新增失敗。

- [ ] **Step 6: Commit**

```bash
git -C /Users/hank_y_lin/projects/agent-orchestrator add \
  packages/web/src/components/Dashboard.tsx \
  packages/web/src/components/__tests__/Dashboard.issueBrowser.test.tsx
git -C /Users/hank_y_lin/projects/agent-orchestrator commit -m "feat: add Issue Browser toggle to Dashboard"
```

---

## Task 4: Build 並重啟 ao

- [ ] **Step 1: 重新 build web package**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator/packages/web
pnpm build
```

預期：build 成功，最後顯示 `✓ Compiled successfully`

- [ ] **Step 2: 重啟 ao（從 agent-orchestrator 目錄）**

```bash
cd /Users/hank_y_lin/projects/agent-orchestrator
ao stop && ao start
```

- [ ] **Step 3: 驗證**

瀏覽 `http://localhost:3000`，進入 `paradise-soft` 專案：
- Header 右側出現「Issues」按鈕
- 點擊後切換顯示 WIN issues 列表（ID、標題、↗連結、Spawn 按鈕）
- 再點「Sessions」切回 Kanban
- 點任一 Spawn → session 出現在 Kanban，Toast 通知「WIN-XXXX spawned」
