# Issue Browser Panel — Design Spec

**Date:** 2026-04-28  
**Status:** Approved

## Goal

在 dashboard 主內容區新增一個 Issue Browser Panel，讓使用者能看到 tracker（Jira 等）的可用 issues，並直接從 dashboard spawn agent session。

## UI 行為

- Dashboard header 右側新增一顆 toggle 按鈕（和現有 debug 按鈕同排）
- 預設顯示 Kanban（Sessions 模式）
- 點擊 toggle → 主內容區整個切換為 IssuePanel（Issues 模式）
- 再點一次切回 Kanban
- 按鈕文字/圖示對應當前模式：顯示 Kanban 時按鈕標示「Issues」，反之標示「Sessions」

## 元件結構

```
Dashboard.tsx
  ├── header
  │     └── toggle button（新增）
  ├── showIssues === false → Kanban（AttentionZone 等，現有）
  └── showIssues === true  → <IssuePanel projectId={projectId} />（新增）
```

### Dashboard.tsx 改動

- 新增 `const [showIssues, setShowIssues] = useState(false)`
- Header 新增 toggle button，點擊時切換 `showIssues`
- 主內容區條件渲染：`showIssues ? <IssuePanel> : <現有 Kanban>`
- 總計約 +15 行

### IssuePanel.tsx（新檔案，~120 行）

**Props**
```typescript
interface IssuePanelProps {
  projectId: string;
}
```

**資料流**
1. 元件 mount 時 fetch `GET /api/issues?state=open&project={projectId}`
2. 三種渲染狀態：
   - Loading：顯示 `<Skeleton>` 骨架屏
   - Error：顯示錯誤訊息
   - Data：顯示 issue 列表（最多 50 筆）

**每行 issue 顯示**
```
[WIN-2578]  標題文字（超長截斷）  [↗]  [Spawn]
```
- `id`：等寬字體，muted 色
- `title`：主要文字，`truncate`
- Jira 連結（`↗`）：`target="_blank"` 開新分頁
- Spawn 按鈕：點擊後觸發 spawn 流程

**Spawn 流程**
1. 點擊 Spawn → 該 row 按鈕進入 loading 狀態（disabled）
2. POST `/api/spawn` with `{ projectId, issueId }`
3. 成功 → `setShowIssues(false)` 切回 Kanban + Toast「{issueId} spawned」
4. 失敗 → 按鈕恢復可點擊 + 該 row inline 顯示錯誤訊息

## 樣式

沿用現有設計系統 CSS 變數，不引入新 token：

| 元素 | 樣式 |
|------|------|
| Panel 背景 | `var(--color-bg-surface)` |
| Row hover | `var(--color-bg-elevated)` |
| Row 分隔線 | `border-b var(--color-border-subtle)` |
| Issue ID | `font-mono text-[var(--color-text-tertiary)]` |
| 標題 | `text-[var(--color-text-primary)] truncate` |
| Spawn 按鈕 | 與 SessionCard action button 同款 |
| Loading 骨架 | 現有 `<Skeleton>` 元件 |

## 改動範圍

| 檔案 | 類型 | 說明 |
|------|------|------|
| `packages/web/src/components/Dashboard.tsx` | 修改 | +state、+toggle button、+條件渲染 |
| `packages/web/src/components/IssuePanel.tsx` | 新增 | Issue Browser Panel 主元件 |

不需要改動 API routes（`/api/issues`、`/api/spawn` 已存在且介面相符）。

## 不在範圍內

- 篩選（sprint、assignee、label）
- 關鍵字搜尋
- Pagination（50 筆上限由現有 API 控制）
- Issue 詳情展開
