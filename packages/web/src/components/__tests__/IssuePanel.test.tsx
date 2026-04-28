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

    fireEvent.click(screen.getAllByRole("button", { name: /spawn/i })[0]);

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

    fireEvent.click(screen.getAllByRole("button", { name: /spawn/i })[0]);

    await waitFor(() => {
      expect(screen.getByText("Session limit reached")).toBeInTheDocument();
    });
  });

  it("disables Spawn button while spawning is in progress", async () => {
    let resolveSpawn!: (value: Response) => void;
    vi.mocked(fetch)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ issues: ISSUES }),
      } as Response)
      .mockReturnValueOnce(
        new Promise<Response>((resolve) => {
          resolveSpawn = resolve;
        }),
      );

    renderWithToast(<IssuePanel projectId="paradise-soft" onSpawned={vi.fn()} />);
    await waitFor(() => screen.getByText("WIN-1"));

    fireEvent.click(screen.getAllByRole("button", { name: /spawn/i })[0]);

    // 按鈕應在 spawning 期間 disabled
    await waitFor(() => {
      expect(screen.getAllByRole("button", { name: /spawn/i })[0]).toBeDisabled();
    });

    // 完成 spawn
    resolveSpawn({ ok: true, json: async () => ({ session: { id: "s1" } }) } as Response);
  });

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
});
