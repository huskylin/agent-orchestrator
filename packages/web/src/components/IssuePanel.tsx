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
