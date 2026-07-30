/**
 * Fail-closed payload validation (src/payload.ts, SPEC.md §3). The schema (src/types.ts) decides
 * the shape rather than a hand-written narrowing, so the matrix below has to state both halves:
 * what the schema accepts and normalizes, and what shape of body it must refuse to model at all.
 */

import { HUMAN, OCTOCAT } from "./accounts";
import { describe, expect, it } from "vitest";
import type { PullRequestEventPayload } from "../src/types";
import { parsePullRequestEvent } from "../src/payload";

const HEAD_SHA = "head-sha";

function expectedPayload(): PullRequestEventPayload {
	return {
		action: "opened",
		installation: { id: 12_345 },
		pull_request: {
			commits: 3,
			draft: false,
			head: { repo: { id: 555 }, sha: HEAD_SHA },
			number: 42,
			state: "open",
			user: OCTOCAT,
		},
		repository: { full_name: "octocat/widgets", id: 555, name: "widgets", owner: OCTOCAT },
	};
}

function merged(base: object, overrides: Record<string, unknown>): Record<string, unknown> {
	const target: Record<string, unknown> = {};
	return Object.assign(target, base, overrides);
}

function pr(pullRequestOverrides: Record<string, unknown>): Record<string, unknown> {
	const base = expectedPayload();
	return merged(base, { pull_request: merged(base.pull_request, pullRequestOverrides) });
}

/* An absent installation is left absent and a malformed one is replaced with null, which the
 * pipeline settles alike as missing-installation (SPEC.md §9) — neither invalidates the body. */
const WITHOUT_INSTALLATION = {
	action: "opened",
	pull_request: expectedPayload().pull_request,
	repository: expectedPayload().repository,
};
const NULL_INSTALLATION = merged(expectedPayload(), { installation: null });
const NULL_HEAD_REPO = pr({ head: { repo: null, sha: HEAD_SHA } });

const PARSE_OK_CASES = [
	{ expected: expectedPayload(), name: "a fully populated payload", payload: expectedPayload() },
	{
		expected: expectedPayload(),
		name: "extra unmodeled fields",
		payload: merged(expectedPayload(), { sender: HUMAN }),
	},
	{ expected: WITHOUT_INSTALLATION, name: "installation absent", payload: WITHOUT_INSTALLATION },
	{
		expected: NULL_INSTALLATION,
		name: "installation id not numeric",
		payload: merged(expectedPayload(), { installation: { id: "12" } }),
	},
	{
		expected: NULL_INSTALLATION,
		name: "installation not an object",
		payload: merged(expectedPayload(), { installation: "x" }),
	},
	{ expected: NULL_HEAD_REPO, name: "head repo null", payload: NULL_HEAD_REPO },
	{ expected: NULL_HEAD_REPO, name: "head repo absent", payload: pr({ head: { sha: HEAD_SHA } }) },
];

const MALFORMED_PAYLOADS = [
	{ name: "payload not an object", payload: "not-an-object" },
	{ name: "payload null", payload: null },
	{ name: "payload an array", payload: [expectedPayload()] },
	{
		name: "action missing",
		payload: {
			pull_request: expectedPayload().pull_request,
			repository: expectedPayload().repository,
		},
	},
	{ name: "action not a string", payload: merged(expectedPayload(), { action: 404 }) },
	{
		name: "pull_request missing",
		payload: { action: "opened", repository: expectedPayload().repository },
	},
	{
		name: "pull_request not an object",
		payload: merged(expectedPayload(), { pull_request: "pr" }),
	},
	{ name: "number not a number", payload: pr({ number: "42" }) },
	{ name: "commits not a number", payload: pr({ commits: "3" }) },
	{ name: "draft not a boolean", payload: pr({ draft: "false" }) },
	{ name: "state not a string", payload: pr({ state: 7 }) },
	{ name: "user not an object", payload: pr({ user: "octocat" }) },
	{ name: "user id not numeric", payload: pr({ user: { id: "1", login: "o", type: "User" } }) },
	{ name: "head not an object", payload: pr({ head: "deadbeef" }) },
	{ name: "head sha missing", payload: pr({ head: { repo: { id: 555 } } }) },
	{ name: "head repo not an object", payload: pr({ head: { repo: "x", sha: HEAD_SHA } }) },
	{ name: "head repo id not numeric", payload: pr({ head: { repo: { id: "5" }, sha: HEAD_SHA } }) },
	{
		name: "repository missing",
		payload: { action: "opened", pull_request: expectedPayload().pull_request },
	},
	{
		name: "repository owner id missing",
		payload: merged(expectedPayload(), {
			repository: { full_name: "o/w", id: 555, name: "w", owner: { login: "o", type: "User" } },
		}),
	},
	{
		name: "full_name not a string",
		payload: merged(expectedPayload(), {
			repository: { full_name: 7, id: 555, name: "w", owner: OCTOCAT },
		}),
	},
	{
		name: "repository id missing",
		payload: merged(expectedPayload(), {
			repository: { full_name: "o/w", name: "w", owner: OCTOCAT },
		}),
	},
];

describe("webhook payload validation", () => {
	it("builds a new object instead of returning the input", () => {
		expect.hasAssertions();
		const payload = expectedPayload();
		expect(parsePullRequestEvent(payload)).not.toBe(payload);
	});

	it.each(PARSE_OK_CASES)("accepts $name", ({ expected, payload }) => {
		expect.hasAssertions();
		expect(parsePullRequestEvent(payload)).toStrictEqual(expected);
	});

	it.each(MALFORMED_PAYLOADS)("returns null for $name", ({ payload }) => {
		expect.hasAssertions();
		expect(parsePullRequestEvent(payload)).toBeNull();
	});
});
