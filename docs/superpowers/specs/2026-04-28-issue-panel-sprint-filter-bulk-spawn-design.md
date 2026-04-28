# IssuePanel Sprint Filter + Bulk Spawn — Design Spec

**Date:** 2026-04-28  
**Status:** Approved

## Goal

在現有的 IssuePanel 新增兩個功能：(1) Sprint filter 按鈕，只顯示目前 active sprint 的 issues；(2) checkbox 選取 + 批量 spawn，讓使用者快速 spawn 整個 sprint 的 issues。

## 架構決策

採用 **Core types 延伸** 方案：在 `IssueFilters` 加 `sprint?: "active"` 欄位，由 Jira plugin 實作；其他 plugin 直接忽略。現有 `/api/issues` endpoint 透傳 `sprint` query param，不新增 endpoint。

## 改動範圍

| 檔案 | 類型 | 說明 |
|------|------|------|
| `packages/core/src/types.ts` | 修改 | `IssueFilters` 加 `sprint?: "active"` |
| `packages/plugins/tracker-jira/src/index.ts` | 修改 | Jira config 加 `boardId`；`listIssues` 實作 sprint JQL |
| `packages/web/src/app/api/issues/route.ts` | 修改 | 讀取 `?sprint=active` query param 並透傳 |
| `packages/web/src/components/IssuePanel.tsx` | 修改 | Sprint toggle、checkbox 選取、bulk spawn UI |
| `packages/web/src/components/__tests__/IssuePanel.test.tsx` | 修改 | 新增 sprint filter 和 bulk spawn 測試 |
| `agent-orchestrator.yaml`（使用者設定，非 repo 內） | 修改說明 | 需手動加 `boardId: 359` |

## Section 1：資料層

### 1.1 Core types

`packages/core/src/types.ts`：

```typescript
export interface IssueFilters {
  state?: "open" | "closed";
  labels?: string[];
  assignee?: string;
  limit?: number;
  sprint?: "active";  // 新增
}
```

### 1.2 Jira plugin config

`packages/plugins/tracker-jira/src/index.ts` 的 Jira tracker config type 加 `boardId?: number`：

```typescript
interface JiraTrackerConfig {
  baseUrl: string;
  project: string;
  boardId?: number;  // 新增，用於 active sprint 查詢
  // ...existing fields
}
```

使用者需在 `agent-orchestrator.yaml` 的 tracker 區塊加：

```yaml
tracker:
  plugin: jira
  boardId: 359  # 新增
```

### 1.3 Jira plugin listIssues — sprint 實作

當 `filters.sprint === "active"` 且 `project.tracker.boardId` 已設定時：

1. 呼叫 `GET /rest/agile/1.0/board/{boardId}/sprint?state=active`
2. 取 `values[0].id` 作為 `sprintId`
3. JQL 加上 `AND sprint = {sprintId}`

若 `boardId` 未設定，忽略 sprint filter（不報錯，直接回傳所有 open issues）。

### 1.4 `/api/issues` route

`packages/web/src/app/api/issues/route.ts` 新增讀取 `sprint` query param：

```typescript
const sprint = searchParams.get("sprint");
const filters: IssueFilters = {
  state: "open",
  limit: 50,
  ...(sprint === "active" && { sprint: "active" }),
};
```

## Section 2：IssuePanel UI

### 2.1 Sprint toggle button

IssuePanel header 加 `sprintOnly` state（預設 `false`）。有一顆切換按鈕：

- `sprintOnly === false`：按鈕顯示「目前 Sprint」（點擊切到 sprint 模式）
- `sprintOnly === true`：按鈕顯示「所有 Issues」（點擊切回全部模式）

切換時重置 `selectedIds` 為空 Set，重新 fetch（loading skeleton 再出現）。

Fetch URL：
- 全部：`/api/issues?state=open&project={projectId}`
- Sprint：`/api/issues?state=open&project={projectId}&sprint=active`

### 2.2 選取 UI

每個 issue row 左側加 `<input type="checkbox">`，`aria-label="選取 {issue.id}"`。

Header 區加全選 checkbox + 計數 + Bulk Spawn 按鈕：

```
☑ 全選 (N)     [Spawn 選取的 (N)]
```

- 全選 checkbox：勾選所有目前顯示 issues，再點取消全選
- Bulk Spawn 按鈕：只在 `selectedIds.size > 0` 時顯示；bulk spawn 進行中時 disabled

State：

```typescript
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
const [isBulkSpawning, setIsBulkSpawning] = useState(false);
```

### 2.3 視覺佈局

```
┌─────────────────────────────────────────────────────────┐
│ Issues  [目前 Sprint]  ☑ 全選(3)  [Spawn 選取的(3)]     │
├─────────────────────────────────────────────────────────┤
│ ☑  WIN-123  標題文字...                    [↗]  [Spawn] │
│ ☑  WIN-124  另一個標題...                  [↗]  [Spawn] │
│ ☐  WIN-125  第三個標題...                  [↗]  [Spawn] │
└─────────────────────────────────────────────────────────┘
```

### 2.4 Bulk spawn 流程

1. 設 `isBulkSpawning = true`，所有單一 Spawn 按鈕 disabled
2. 依序迭代 `selectedIds`：
   a. `GET /api/sessions` 確認 active session 數 < 5（`MAX_CONCURRENT_AGENTS`）；超過則停止迭代，顯示 Toast「已達上限，spawn 了 N 個」
   b. `POST /api/spawn` with `{ projectId, issueId }`
   c. 成功：繼續下一個
   d. 失敗：在該 row 顯示 inline 錯誤，繼續下一個
3. 全部完成：`setShowIssues(false)` 切回 Kanban + Toast「已 spawn N 個 issue」

### 2.5 單一 Spawn 按鈕行為不變

與原本相同：loading → `setShowIssues(false)` + Toast。Bulk spawn 進行中時，單一 Spawn 按鈕全部 disabled。

## 不在範圍內

- 其他 plugin（GitHub Issues、Linear）實作 sprint 支援
- Sprint 名稱顯示在 header 上
- Spawn 進度條或逐一 Toast
- 取消進行中的 bulk spawn
