import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "../Dashboard";

const eventSourceConstructorMock = vi.hoisted(() => vi.fn());

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

beforeEach(() => {
  const eventSourceMock = { onmessage: null, onerror: null, close: vi.fn() };
  eventSourceConstructorMock.mockReset();
  eventSourceConstructorMock.mockImplementation(() => eventSourceMock as unknown as EventSource);
  global.EventSource = Object.assign(eventSourceConstructorMock, {
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
        expect.any(Object),
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

    // Button label changes to "Sessions" (exact aria-label match)
    const sessionsToggle = screen.getByRole("button", { name: "Sessions" });
    fireEvent.click(sessionsToggle);

    // Back to issues mode button
    expect(screen.queryByRole("button", { name: "Sessions" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /issues/i })).toBeInTheDocument();
  });
});
