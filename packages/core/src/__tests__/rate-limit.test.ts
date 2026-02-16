/**
 * Tests for rate limit types and errors
 */

import { describe, it, expect, vi } from "vitest";
import { RateLimitError } from "../types.js";

describe("RateLimitError", () => {
  it("should create error with correct properties", () => {
    const resetAt = new Date("2026-02-16T10:30:00Z");
    const error = new RateLimitError("graphql", resetAt);

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error.name).toBe("RateLimitError");
    expect(error.code).toBe("RATE_LIMIT_EXCEEDED");
    expect(error.resource).toBe("graphql");
    expect(error.resetAt).toBe(resetAt);
  });

  it("should calculate retryAfter correctly", () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-16T10:00:00Z");
    vi.setSystemTime(now);

    const resetAt = new Date("2026-02-16T10:10:00Z"); // 10 minutes later
    const error = new RateLimitError("graphql", resetAt);

    expect(error.retryAfter).toBe(600); // 10 minutes in seconds

    vi.useRealTimers();
  });

  it("should have human-readable error message", () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-16T10:00:00Z");
    vi.setSystemTime(now);

    const resetAt = new Date("2026-02-16T10:17:00Z"); // 17 minutes later
    const error = new RateLimitError("graphql", resetAt);

    expect(error.message).toContain("Rate limit exceeded");
    expect(error.message).toContain("graphql");
    expect(error.message).toContain("17 minutes");

    vi.useRealTimers();
  });

  it("should handle retryAfter less than 60 seconds", () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-16T10:00:00Z");
    vi.setSystemTime(now);

    const resetAt = new Date("2026-02-16T10:00:30Z"); // 30 seconds later
    const error = new RateLimitError("rest", resetAt);

    expect(error.retryAfter).toBe(30);
    expect(error.message).toContain("1 minutes"); // Ceiling of 30s / 60 = 1 min

    vi.useRealTimers();
  });

  it("should handle resetAt in the past (edge case)", () => {
    vi.useFakeTimers();
    const now = new Date("2026-02-16T10:00:00Z");
    vi.setSystemTime(now);

    const resetAt = new Date("2026-02-16T09:55:00Z"); // 5 minutes ago
    const error = new RateLimitError("core", resetAt);

    // retryAfter should be 0 (already reset)
    expect(error.retryAfter).toBe(0);

    vi.useRealTimers();
  });

  it("should support cause option for error chaining", () => {
    const originalError = new Error("GitHub API error");
    const resetAt = new Date("2026-02-16T10:30:00Z");
    const error = new RateLimitError("graphql", resetAt, { cause: originalError });

    expect(error.cause).toBe(originalError);
  });

  it("should work for different resource types", () => {
    const resetAt = new Date("2026-02-16T10:30:00Z");

    const graphqlError = new RateLimitError("graphql", resetAt);
    expect(graphqlError.resource).toBe("graphql");

    const restError = new RateLimitError("rest", resetAt);
    expect(restError.resource).toBe("rest");

    const searchError = new RateLimitError("search", resetAt);
    expect(searchError.resource).toBe("search");
  });
});
