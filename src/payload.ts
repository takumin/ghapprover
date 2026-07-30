/**
 * Fail-closed structural validation of the pull_request delivery body (SPEC.md §3, §11): the
 * schema (src/types.ts) is what decides whether a body matches the modeled shape, and this module
 * is where the entry point asks it. Split from the decision logic (src/decision.ts) because it
 * answers a different question — whether the delivery can be modeled at all, rather than whether
 * the modeled pull request may be approved.
 */

import type { PullRequestEventPayload } from "./types";
import { pullRequestEventSchema } from "./types";
import { safeParse } from "valibot";

/* The whole body, or null when it does not match the modeled shape — a missing or malformed
 * installation being the one divergence the schema absorbs rather than rejects (SPEC.md §9). */
export function parsePullRequestEvent(payload: unknown): PullRequestEventPayload | null {
	const result = safeParse(pullRequestEventSchema, payload);
	if (!result.success) {
		return null;
	}
	return result.output;
}
