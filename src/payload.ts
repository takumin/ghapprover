/**
 * Fail-closed structural validation of the pull_request delivery body (SPEC.md §3, §11): the
 * schema (src/types.ts) decides whether the delivery can be modeled at all, and this module turns
 * its answer into what the entry point logs — the rebuilt payload, or the dot path of the field
 * that failed (§8). Split from the decision logic (src/decision.ts) because it answers a different
 * question than whether the modeled pull request may be approved.
 */

import { getDotPath, safeParse } from "valibot";
import type { BaseIssue } from "valibot";
import type { PullRequestEventPayload } from "./types";
import { pullRequestEventSchema } from "./types";

/**
 * The modeled payload, or no payload and SPEC.md §8's `field`: the dot path of the first field that
 * failed validation. The path alone — the issue also carries the value that failed, which is
 * webhook payload content and never leaves this module (§8 warning, §11).
 */
export interface PayloadValidation {
	readonly field?: string | undefined;
	readonly payload?: PullRequestEventPayload | undefined;
}

/* An issue at the root — a body that is not an object at all has no field to name — has no dot
 * path, and becomes an absent `field` rather than one logged empty (SPEC.md §8). */
function issueField(issue: BaseIssue<unknown>): string | undefined {
	return getDotPath(issue) ?? undefined;
}

/* The whole body, or no payload at all when it does not match the modeled shape — a missing or
 * malformed installation being the one divergence the schema absorbs rather than rejects (SPEC.md
 * §9). The first issue is the one reported: the schema states its fields in a fixed order, so which
 * field a given malformed body names does not vary between deliveries. */
export function parsePullRequestEvent(payload: unknown): PayloadValidation {
	const result = safeParse(pullRequestEventSchema, payload);
	if (result.success) {
		return { payload: result.output };
	}
	return { field: issueField(result.issues[0]) };
}

/**
 * The delivery body itself, which is what the entry point actually holds: whether it is JSON at all
 * is a fact about the body's validity, so it is settled here rather than at the seam that reads it.
 * A body that is not JSON is not the modeled shape either, and names no field: there is no document
 * to locate one in (SPEC.md §8).
 */
export function parsePullRequestEventBody(body: string): PayloadValidation {
	try {
		const parsed: unknown = JSON.parse(body);
		return parsePullRequestEvent(parsed);
	} catch {
		return {};
	}
}
