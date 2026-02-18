/**
 * Pure formatting utilities safe for both server and client components.
 * No side effects, no external dependencies.
 */

import type { DashboardSession } from "./types";

/**
 * Humanize a git branch name into a readable title.
 * e.g., "feat/infer-project-id" → "Infer Project ID"
 *       "fix/broken-auth-flow"  → "Broken Auth Flow"
 *       "session/ao-52"         → "ao-52"
 */
export function humanizeBranch(branch: string): string {
  // Remove common prefixes
  const withoutPrefix = branch.replace(
    /^(?:feat|fix|chore|refactor|docs|test|ci|session|release|hotfix|feature|bugfix|build|wip|improvement)\//,
    "",
  );
  // Replace hyphens and underscores with spaces, then title-case each word
  return withoutPrefix
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * Detect if a summary string looks like a truncated spawn prompt rather
 * than a real agent-generated summary.
 *
 * When Claude Code hasn't generated a "summary" entry in its JSONL yet,
 * extractSummary() falls back to the first user message truncated to 120
 * chars. That message is typically the spawn prompt (built by
 * prompt-builder.ts + tracker.generatePrompt()), which makes a poor title.
 */
export function looksLikePromptExcerpt(summary: string): boolean {
  return (
    summary.startsWith("You are working on") ||
    summary.startsWith("You are an AI coding agent") ||
    summary.startsWith("Work on ") ||
    summary.includes("Issue URL:") ||
    summary.includes("Please implement the changes") ||
    summary.includes("## Session Lifecycle")
  );
}

/**
 * Compute the best display title for a session card.
 *
 * Fallback chain (ordered by signal quality):
 *   1. PR title         — human-visible deliverable name
 *   2. Quality summary   — real agent-generated summary (not a prompt excerpt)
 *   3. Issue title       — human-written task description
 *   4. Any summary       — even a prompt excerpt is better than nothing
 *   5. Humanized branch  — last resort with semantic content
 *   6. Status text       — absolute fallback
 */
export function getSessionTitle(session: DashboardSession): string {
  // 1. PR title — always best
  if (session.pr?.title) return session.pr.title;

  // 2. Quality summary — real agent summary, not a prompt excerpt
  if (session.summary && !looksLikePromptExcerpt(session.summary)) {
    return session.summary;
  }

  // 3. Issue title — human-written task description
  if (session.issueTitle) return session.issueTitle;

  // 4. Any summary — even prompt excerpts beat branch names
  if (session.summary) return session.summary;

  // 5. Humanized branch
  if (session.branch) return humanizeBranch(session.branch);

  // 6. Status
  return session.status;
}
