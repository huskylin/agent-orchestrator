/**
 * tracker-jira plugin — Jira Server (REST API v2) as an issue tracker.
 *
 * Compatible with Jira Server 8.x (REST API 8.5.6).
 * https://docs.atlassian.com/software/jira/docs/api/REST/8.5.6/
 *
 * Config (in agent-orchestrator.yaml):
 *   tracker:
 *     plugin: jira
 *     path: ./packages/plugins/tracker-jira
 *     baseUrl: https://jira.yourcompany.com   # Jira Server base URL
 *     email: you@yourcompany.com              # or username for older Jira
 *     token: <JIRA_TOKEN>                     # API token or password
 *     project: PROJ                           # default Jira project key
 */

import type {
  PluginModule,
  Tracker,
  Issue,
  IssueFilters,
  IssueUpdate,
  CreateIssueInput,
  ProjectConfig,
} from "@aoagents/ao-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface JiraConfig {
  baseUrl: string;
  email?: string;
  token?: string;
  project?: string;
  boardId?: number;
}

interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary: string;
    description?: string;
    status: {
      statusCategory: { key: string };
      name: string;
    };
    labels: string[];
    assignee?: { displayName: string; name?: string; emailAddress?: string };
    priority?: { id: string; name: string };
    issuetype: { name: string };
  };
}

interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
}

interface JiraTransition {
  id: string;
  name: string;
  to: { statusCategory: { key: string } };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    boardId: typeof tracker.boardId === "number"
      ? tracker.boardId
      : typeof tracker.boardId === "string"
        ? parseInt(tracker.boardId, 10) || undefined
        : undefined,
  };
}

function makeAuthHeader(config: JiraConfig): string {
  const email = config.email ?? process.env.JIRA_EMAIL ?? "";
  const token = config.token ?? process.env.JIRA_TOKEN ?? "";
  if (!email || !token) {
    throw new Error(
      "Jira tracker requires email and token. Set them in tracker config or via JIRA_EMAIL / JIRA_TOKEN env vars.",
    );
  }
  return "Basic " + Buffer.from(`${email}:${token}`).toString("base64");
}

async function jiraFetch<T>(
  config: JiraConfig,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${config.baseUrl}/rest/api/2${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": makeAuthHeader(config),
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira API ${options.method ?? "GET"} ${path} failed (${res.status}): ${body}`);
  }

  // 204 No Content
  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

async function jiraAgileFetch<T>(
  config: JiraConfig,
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const url = `${config.baseUrl}/rest/agile/1.0${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Authorization": makeAuthHeader(config),
      "Content-Type": "application/json",
      "Accept": "application/json",
      ...(options.headers ?? {}),
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Jira Agile API ${options.method ?? "GET"} ${path} failed (${res.status}): ${body}`);
  }

  if (res.status === 204) return undefined as T;

  return res.json() as Promise<T>;
}

async function getActiveSprintId(config: JiraConfig): Promise<number | null> {
  if (config.boardId === undefined) return null;
  try {
    const result = await jiraAgileFetch<{ values: Array<{ id: number }> }>(
      config,
      `/board/${config.boardId}/sprint?state=active`,
    );
    return result.values[0]?.id ?? null;
  } catch (err) {
    console.warn(`[tracker-jira] Failed to fetch active sprint for board ${config.boardId}:`, err);
    return null;
  }
}

function mapStatus(statusCategory: string): Issue["state"] {
  switch (statusCategory.toLowerCase()) {
    case "done":
      return "closed";
    case "indeterminate":
      return "in_progress";
    case "new":
    case "undefined":
    default:
      return "open";
  }
}

function mapJiraIssue(issue: JiraIssue, baseUrl: string): Issue {
  return {
    id: issue.key,
    title: issue.fields.summary,
    description: issue.fields.description ?? "",
    url: `${baseUrl}/browse/${issue.key}`,
    state: mapStatus(issue.fields.status.statusCategory.key),
    labels: issue.fields.labels ?? [],
    assignee:
      issue.fields.assignee?.emailAddress ??
      issue.fields.assignee?.name ??
      issue.fields.assignee?.displayName,
    priority: issue.fields.priority ? Number(issue.fields.priority.id) : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tracker implementation
// ---------------------------------------------------------------------------

function createJiraTracker(): Tracker {
  return {
    name: "jira",

    async getIssue(identifier: string, project: ProjectConfig): Promise<Issue> {
      const config = getConfig(project);
      const issue = await jiraFetch<JiraIssue>(config, `/issue/${identifier}`);
      return mapJiraIssue(issue, config.baseUrl);
    },

    async isCompleted(identifier: string, project: ProjectConfig): Promise<boolean> {
      const config = getConfig(project);
      const issue = await jiraFetch<JiraIssue>(config, `/issue/${identifier}?fields=status`);
      return issue.fields.status.statusCategory.key.toLowerCase() === "done";
    },

    issueUrl(identifier: string, project: ProjectConfig): string {
      const config = getConfig(project);
      return `${config.baseUrl}/browse/${identifier}`;
    },

    issueLabel(url: string, _project: ProjectConfig): string {
      // Extract issue key from URL: https://jira.company.com/browse/PROJ-123 → "PROJ-123"
      const match = url.match(/\/browse\/([A-Z][A-Z0-9_]+-\d+)/);
      return match ? match[1] : url.split("/").pop() ?? url;
    },

    branchName(identifier: string, _project: ProjectConfig): string {
      // e.g. PROJ-123 → feat/PROJ-123
      return `feat/${identifier}`;
    },

    async generatePrompt(identifier: string, project: ProjectConfig): Promise<string> {
      const issue = await this.getIssue(identifier, project);
      const lines = [
        `You are working on Jira issue ${issue.id}: ${issue.title}`,
        `Issue URL: ${issue.url}`,
        `Status: ${issue.state}`,
        "",
      ];

      if (issue.labels.length > 0) {
        lines.push(`Labels: ${issue.labels.join(", ")}`);
      }

      if (issue.description) {
        lines.push("## Description", "", issue.description);
      }

      lines.push(
        "",
        "Please implement the changes described in this issue. When done, commit and push your changes.",
      );

      return lines.join("\n");
    },

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

    async updateIssue(
      identifier: string,
      update: IssueUpdate,
      project: ProjectConfig,
    ): Promise<void> {
      const config = getConfig(project);

      // Derive target Jira transition name from explicit state or from label hints.
      // Labels added by AO lifecycle:
      //   "agent:in-progress"   → In Progress
      //   "merged-unverified"   → In Review
      //   "verified"            → Done  (state: "closed" also triggers this)
      //   "verification-failed" → To Do (state: "open" also triggers this)
      //   "agent:backlog"       → BACKLOG
      let targetTransitionName: string | undefined;

      if (update.state === "closed") {
        targetTransitionName = "Done";
      } else if (update.state === "open") {
        targetTransitionName = "To Do";
      } else if (update.labels?.includes("agent:in-progress")) {
        targetTransitionName = "In Progress";
      } else if (update.labels?.includes("agent:in-review")) {
        // PR opened — move to In Review immediately
        targetTransitionName = "In Review";
      } else if (update.labels?.includes("merged-unverified")) {
        // PR merged — verification handled elsewhere, mark as Done directly
        targetTransitionName = "Done";
      } else if (update.labels?.includes("agent:backlog")) {
        targetTransitionName = "BACKLOG";
      }

      if (targetTransitionName) {
        const transitions = await jiraFetch<{ transitions: JiraTransition[] }>(
          config,
          `/issue/${identifier}/transitions`,
        );

        const transition = transitions.transitions.find(
          (t) => t.name === targetTransitionName,
        );

        if (transition) {
          await jiraFetch(config, `/issue/${identifier}/transitions`, {
            method: "POST",
            body: JSON.stringify({ transition: { id: transition.id } }),
          });
        }
      }

      // Handle label changes
      const fieldUpdates: Record<string, unknown> = {};

      if (update.labels || update.removeLabels) {
        const current = await this.getIssue(identifier, project);
        let labels = [...current.labels];
        if (update.removeLabels) {
          labels = labels.filter((l) => !update.removeLabels!.includes(l));
        }
        if (update.labels) {
          for (const l of update.labels) {
            if (!labels.includes(l)) labels.push(l);
          }
        }
        fieldUpdates.labels = labels;
      }

      if (update.assignee) {
        fieldUpdates.assignee = { name: update.assignee };
      }

      if (Object.keys(fieldUpdates).length > 0) {
        await jiraFetch(config, `/issue/${identifier}`, {
          method: "PUT",
          body: JSON.stringify({ fields: fieldUpdates }),
        });
      }

      // Add comment
      if (update.comment) {
        await jiraFetch(config, `/issue/${identifier}/comment`, {
          method: "POST",
          body: JSON.stringify({ body: update.comment }),
        });
      }
    },

    async addComment(identifier: string, body: string, project: ProjectConfig): Promise<void> {
      const config = getConfig(project);
      await jiraFetch(config, `/issue/${identifier}/comment`, {
        method: "POST",
        body: JSON.stringify({ body }),
      });
    },

    async createIssue(input: CreateIssueInput, project: ProjectConfig): Promise<Issue> {
      const config = getConfig(project);
      const projectKey = config.project;
      if (!projectKey) {
        throw new Error("Jira tracker requires 'project' key in tracker config (e.g. PROJ)");
      }

      const body: Record<string, unknown> = {
        fields: {
          project: { key: projectKey },
          summary: input.title,
          description: input.description ?? "",
          issuetype: { name: "Story" },
          ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
          ...(input.assignee ? { assignee: { name: input.assignee } } : {}),
        },
      };

      const created = await jiraFetch<{ id: string; key: string }>(config, "/issue", {
        method: "POST",
        body: JSON.stringify(body),
      });

      return this.getIssue(created.key, project);
    },
  };
}

// ---------------------------------------------------------------------------
// Plugin module export
// ---------------------------------------------------------------------------

export const manifest = {
  name: "jira",
  slot: "tracker" as const,
  description: "Tracker plugin: Jira Server (REST API v2, compatible with 8.x)",
  version: "0.1.0",
};

export function create(): Tracker {
  return createJiraTracker();
}

export default { manifest, create } satisfies PluginModule<Tracker>;
