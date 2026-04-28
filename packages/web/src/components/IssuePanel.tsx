"use client";

import { useState, useEffect } from "react";
import { TERMINAL_STATUSES, type SessionStatus } from "@aoagents/ao-core/types";
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

    try {
      for (const id of idsToSpawn) {
        try {
          const sessionsRes = await fetch("/api/sessions");
          const sessionsData = (await sessionsRes.json()) as {
            sessions?: Array<{ status: string }>;
          };
          const activeCount = (sessionsData.sessions ?? []).filter(
            (s) => !TERMINAL_STATUSES.has(s.status as SessionStatus),
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
    } finally {
      setIsBulkSpawning(false);
      setSelectedIds(new Set());
    }

    if (spawnedCount > 0) {
      showToast(`已 spawn ${spawnedCount} 個 issue`, "success");
      onSpawned();
    }
  };

  if (loading) {
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
        </div>
        {Array.from({ length: 8 }, (_, i) => (
          <div key={i} className="issue-panel__row issue-panel__row--skeleton">
            <div className="issue-panel__skeleton-id" />
            <div className="issue-panel__skeleton-title" />
          </div>
        ))}
      </div>
    );
  }

  // Sprint toggle shown in error/empty so user can switch back to all issues
  const sprintToggle = (
    <button
      type="button"
      className="issue-panel__sprint-toggle"
      onClick={() => setSprintOnly((v) => !v)}
    >
      {sprintOnly ? "所有 Issues" : "目前 Sprint"}
    </button>
  );

  if (error) {
    return (
      <div className="issue-panel">
        <div className="issue-panel__toolbar">{sprintToggle}</div>
        <div className="issue-panel--empty">
          <p className="issue-panel__error">{error}</p>
        </div>
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className="issue-panel">
        <div className="issue-panel__toolbar">{sprintToggle}</div>
        <div className="issue-panel--empty">
          <p className="issue-panel__empty">No open issues found.</p>
        </div>
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
