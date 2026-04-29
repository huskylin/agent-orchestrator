import { type NextRequest, NextResponse } from "next/server";
import { getServices } from "@/lib/services";
import { validateString, validateConfiguredProject } from "@/lib/validation";
import type { Tracker } from "@aoagents/ao-core";

export const dynamic = "force-dynamic";

/**
 * POST /api/issues/:issueKey/comment — Append a comment to an issue.
 * Body: { projectId, body }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ issueKey: string }> },
) {
  const { issueKey } = await params;
  const payload = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!payload) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const bodyErr = validateString(payload.body, "body", 32_000);
  if (bodyErr) {
    return NextResponse.json({ error: bodyErr }, { status: 400 });
  }

  const projectId = payload.projectId as string;
  if (!projectId) {
    return NextResponse.json({ error: "projectId is required" }, { status: 400 });
  }

  try {
    const { config, registry } = await getServices();
    const projectErr = validateConfiguredProject(config.projects, projectId);
    if (projectErr) {
      return NextResponse.json({ error: projectErr }, { status: 404 });
    }
    const project = config.projects[projectId];

    if (!project.tracker?.plugin) {
      return NextResponse.json(
        { error: "No tracker configured for this project" },
        { status: 422 },
      );
    }

    const tracker = registry.get<Tracker>("tracker", project.tracker.plugin);
    if (!tracker?.addComment) {
      return NextResponse.json(
        { error: "Tracker does not support comments" },
        { status: 422 },
      );
    }

    await tracker.addComment(issueKey, payload.body as string, project);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Failed to add comment" },
      { status: 500 },
    );
  }
}
