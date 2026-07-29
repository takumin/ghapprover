/**
 * Fail-closed structural validation of the pull_request delivery body (SPEC.md §3): the typed
 * payload is rebuilt field-by-field from narrowed unknown values (never asserted), so a body that
 * does not match the modeled shape yields null. Split from the decision logic (src/decision.ts)
 * because it answers a different question — whether the delivery can be modeled at all, rather
 * than whether the modeled pull request may be approved.
 */

import type {
	EventPullRequest,
	EventRepository,
	PullRequestEventPayload,
	PullRequestHead,
} from "./types";
import { isRecord, toAccount, toIdRef } from "./parse";

/* A deleted head repository is absent rather than malformed, so it parses to null (SPEC.md §3
 * condition 2); undefined is the parse failure, which is what keeps the two apart without boxing the
 * result — the sentinel every narrowing primitive uses (src/parse.ts). */
function parseHeadRepo(value: unknown): PullRequestHead["repo"] | undefined {
	if (value === null || value === undefined) {
		return null;
	}
	return toIdRef(value);
}

function parseHead(value: unknown): PullRequestHead | null {
	if (!isRecord(value)) {
		return null;
	}
	const { repo, sha } = value;
	if (typeof sha !== "string") {
		return null;
	}
	const parsedRepo = parseHeadRepo(repo);
	if (parsedRepo === undefined) {
		return null;
	}
	return { repo: parsedRepo, sha };
}

function parsePullRequest(value: unknown): EventPullRequest | null {
	if (!isRecord(value)) {
		return null;
	}
	const { commits, draft, head, number, state, user } = value;
	if (
		typeof number !== "number" ||
		typeof state !== "string" ||
		typeof draft !== "boolean" ||
		typeof commits !== "number"
	) {
		return null;
	}
	const parsedUser = toAccount(user);
	const parsedHead = parseHead(head);
	if (parsedUser === undefined || parsedHead === null) {
		return null;
	}
	return { commits, draft, head: parsedHead, number, state, user: parsedUser };
}

function parseRepository(value: unknown): EventRepository | null {
	if (!isRecord(value)) {
		return null;
	}
	const { full_name: fullName, id, name, owner } = value;
	if (typeof id !== "number" || typeof name !== "string" || typeof fullName !== "string") {
		return null;
	}
	const parsedOwner = toAccount(owner);
	if (parsedOwner === undefined) {
		return null;
	}
	return { full_name: fullName, id, name, owner: parsedOwner };
}

/** Absent or malformed alike leave the payload valid with no installation (SPEC.md §9). */
function parseInstallation(value: unknown): { readonly id: number } | null {
	return toIdRef(value) ?? null;
}

/* The whole body, or null when it does not match the modeled shape. A missing or malformed
 * installation stays null while the payload remains valid. */
export function parsePullRequestEvent(payload: unknown): PullRequestEventPayload | null {
	if (!isRecord(payload)) {
		return null;
	}
	const { action, installation, pull_request: rawPullRequest, repository: rawRepository } = payload;
	if (typeof action !== "string") {
		return null;
	}
	const pullRequest = parsePullRequest(rawPullRequest);
	const repository = parseRepository(rawRepository);
	if (pullRequest === null || repository === null) {
		return null;
	}
	return {
		action,
		installation: parseInstallation(installation),
		pull_request: pullRequest,
		repository,
	};
}
