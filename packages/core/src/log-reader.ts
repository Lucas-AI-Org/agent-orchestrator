/**
 * Log query and filter utilities for reading JSONL log files.
 *
 * Reads line-by-line, parses JSON (wrapped in try/catch per CLAUDE.md),
 * and applies filters. Supports reading current + rotated files in order.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, basename } from "node:path";
import type { LogEntry, LogQueryOptions } from "./types.js";

/** Read and filter log entries from a single JSONL file. */
export function readLogs(filePath: string, opts?: LogQueryOptions): LogEntry[] {
  if (!existsSync(filePath)) return [];

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const entries: LogEntry[] = [];
  const lines = content.split("\n");

  for (const line of lines) {
    if (!line.trim()) continue;

    let entry: LogEntry;
    try {
      entry = JSON.parse(line) as LogEntry;
    } catch {
      // Corrupted line — skip (per CLAUDE.md: always wrap JSON.parse in try/catch)
      continue;
    }

    if (!matchesFilter(entry, opts)) continue;
    entries.push(entry);

    if (opts?.limit && entries.length >= opts.limit) break;
  }

  return entries;
}

/**
 * Read log entries from a directory, including rotated files.
 * Reads in chronological order: oldest backup first, current file last.
 */
export function readLogsFromDir(
  logDir: string,
  prefix: string,
  opts?: LogQueryOptions,
): LogEntry[] {
  if (!existsSync(logDir)) return [];

  // Find all files matching the prefix pattern
  const files: string[] = [];
  try {
    const dirEntries = readdirSync(logDir);
    for (const entry of dirEntries) {
      if (entry === `${prefix}.jsonl` || entry.match(new RegExp(`^${escapeRegex(prefix)}\\.\\d+\\.jsonl$`))) {
        files.push(entry);
      }
    }
  } catch {
    return [];
  }

  // Sort: highest numbered backup first (oldest), current file last
  files.sort((a, b) => {
    const numA = extractBackupNumber(a);
    const numB = extractBackupNumber(b);
    // Higher backup number = older file, should come first
    return numB - numA;
  });

  const allEntries: LogEntry[] = [];
  const remaining = opts?.limit;

  for (const file of files) {
    const fileOpts = remaining !== undefined
      ? { ...opts, limit: remaining - allEntries.length }
      : opts;

    const entries = readLogs(join(logDir, file), fileOpts);
    allEntries.push(...entries);

    if (remaining !== undefined && allEntries.length >= remaining) break;
  }

  return allEntries;
}

/** Read the last N entries from a log file (most recent first). */
export function tailLogs(filePath: string, lines: number): LogEntry[] {
  if (!existsSync(filePath)) return [];

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  const allLines = content.split("\n").filter((l) => l.trim());
  const lastLines = allLines.slice(-lines);
  const entries: LogEntry[] = [];

  for (const line of lastLines) {
    try {
      entries.push(JSON.parse(line) as LogEntry);
    } catch {
      // Skip corrupted lines
    }
  }

  return entries;
}

/** Check if a log entry matches the given filter options. */
function matchesFilter(entry: LogEntry, opts?: LogQueryOptions): boolean {
  if (!opts) return true;

  if (opts.since) {
    const entryTime = new Date(entry.ts);
    if (entryTime < opts.since) return false;
  }

  if (opts.until) {
    const entryTime = new Date(entry.ts);
    if (entryTime > opts.until) return false;
  }

  if (opts.level && opts.level.length > 0) {
    if (!opts.level.includes(entry.level)) return false;
  }

  if (opts.sessionId) {
    if (entry.sessionId !== opts.sessionId) return false;
  }

  if (opts.source) {
    if (entry.source !== opts.source) return false;
  }

  if (opts.pattern) {
    if (!entry.message.includes(opts.pattern)) return false;
  }

  return true;
}

/** Extract backup number from filename (0 for current file). */
function extractBackupNumber(filename: string): number {
  const match = basename(filename).match(/\.(\d+)\.jsonl$/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Escape regex metacharacters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
