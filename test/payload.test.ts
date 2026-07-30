/**
 * Fail-closed payload validation (src/payload.ts, SPEC.md §3). The schema (src/types.ts) decides
 * the shape rather than a hand-written narrowing, so the matrix below has to state three things:
 * what the schema accepts and normalizes, what shape of body it must refuse to model at all, and
 * — for every refusal — the dot path §8's `field` reports it as. The refusals are asserted on the
 * whole result object rather than on the payload alone, which is what shows the value that failed
 * never rides along with the path (§8 warning).
 */

import { HEAD_SHA, HUMAN, OWNER, REPOSITORY } from "./fixtures";
import { describe, expect, it } from "vitest";
import type { PullRequestEventPayload } from "../src/types";
import { parsePullRequestEvent } from "../src/payload";

function expectedPayload(): PullRequestEventPayload {
	return {
		action: "opened",
		installation: { id: 12_345 },
		pull_request: {
			commits: 3,
			draft: false,
			head: { repo: { id: REPOSITORY.id }, sha: HEAD_SHA },
			number: 42,
			state: "open",
			user: OWNER,
		},
		repository: REPOSITORY,
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

/* Every row states the path §8's `field` carries for it. A body that is not an object at all
 * fails at the root, which has no field to name, so those rows expect no path. An array is an
 * object as far as the schema is concerned, so it fails on the first key it is missing. */
const MALFORMED_PAYLOADS = [
	{ field: undefined, name: "payload not an object", payload: "not-an-object" },
	{ field: undefined, name: "payload null", payload: null },
	{ field: "action", name: "payload an array", payload: [expectedPayload()] },
	{
		field: "action",
		name: "action missing",
		payload: {
			pull_request: expectedPayload().pull_request,
			repository: expectedPayload().repository,
		},
	},
	{
		field: "action",
		name: "action not a string",
		payload: merged(expectedPayload(), { action: 404 }),
	},
	{
		field: "pull_request",
		name: "pull_request missing",
		payload: { action: "opened", repository: expectedPayload().repository },
	},
	{
		field: "pull_request",
		name: "pull_request not an object",
		payload: merged(expectedPayload(), { pull_request: "pr" }),
	},
	{ field: "pull_request.number", name: "number not a number", payload: pr({ number: "42" }) },
	{ field: "pull_request.commits", name: "commits not a number", payload: pr({ commits: "3" }) },
	{ field: "pull_request.draft", name: "draft not a boolean", payload: pr({ draft: "false" }) },
	{ field: "pull_request.state", name: "state not a string", payload: pr({ state: 7 }) },
	{ field: "pull_request.user", name: "user not an object", payload: pr({ user: "octocat" }) },
	{
		field: "pull_request.user.id",
		name: "user id not numeric",
		payload: pr({ user: { id: "1", login: "o", type: "User" } }),
	},
	{ field: "pull_request.head", name: "head not an object", payload: pr({ head: "deadbeef" }) },
	{
		field: "pull_request.head.sha",
		name: "head sha missing",
		payload: pr({ head: { repo: { id: REPOSITORY.id } } }),
	},
	{
		field: "pull_request.head.repo",
		name: "head repo not an object",
		payload: pr({ head: { repo: "x", sha: HEAD_SHA } }),
	},
	{
		field: "pull_request.head.repo.id",
		name: "head repo id not numeric",
		payload: pr({ head: { repo: { id: "5" }, sha: HEAD_SHA } }),
	},
	{
		field: "repository",
		name: "repository missing",
		payload: { action: "opened", pull_request: expectedPayload().pull_request },
	},
	/* The repository rows break the fixture repository rather than restating one of their own, so
	 * each states only the field it is about. */
	{
		field: "repository.owner.id",
		name: "repository owner id missing",
		payload: merged(expectedPayload(), {
			repository: merged(REPOSITORY, { owner: { login: OWNER.login, type: OWNER.type } }),
		}),
	},
	{
		field: "repository.full_name",
		name: "full_name not a string",
		payload: merged(expectedPayload(), { repository: merged(REPOSITORY, { full_name: 7 }) }),
	},
	{
		field: "repository.id",
		name: "repository id missing",
		payload: merged(expectedPayload(), {
			repository: { full_name: REPOSITORY.full_name, name: REPOSITORY.name, owner: OWNER },
		}),
	},
];

describe("webhook payload validation", () => {
	it("builds a new object instead of returning the input", () => {
		expect.hasAssertions();
		const payload = expectedPayload();
		expect(parsePullRequestEvent(payload).payload).not.toBe(payload);
	});

	it.each(PARSE_OK_CASES)("accepts $name", ({ expected, payload }) => {
		expect.hasAssertions();
		expect(parsePullRequestEvent(payload)).toStrictEqual({ payload: expected });
	});

	it.each(MALFORMED_PAYLOADS)("rejects $name, naming $field", ({ field, payload }) => {
		expect.hasAssertions();
		expect(parsePullRequestEvent(payload)).toStrictEqual({ field, payload: null });
	});
});
