/**
 * The SPEC.md §3.2 commit conditions driven through the whole pipeline: what the declared count
 * settles before a single call, what the fetched list settles before any lookup, and how far the
 * per-commit walk gets before a failing commit ends it. The lookups a run does *not* make are as
 * much the assertion as the ones it does — that bound is what keeps a skip from bursting one
 * membership lookup per principal (SPEC.md §3.1, §4).
 */

import { ORG, OWNER, RENOVATE, RENOVATE_WRONG_ID, WEB_FLOW_USER } from "./fixtures";
import { buildPayload, commitsRouteFor, expectSkipped, postSigned } from "./delivery";
import {
	commitItem,
	installTokenRoute,
	membershipAdminRoute,
	membershipMissingRoute,
	membershipUrl,
} from "./github-api";
import { describe, expect, it } from "vitest";
import type { GithubAccount } from "../src/types";
import { MAX_VERIFIABLE_COMMITS } from "../src/commits";
import { installFetchMock } from "./fetch-stub";

/* Two ordinary untrusted commit principals, stated here rather than with the shared account
 * fixtures: this is the only suite that needs them, and what it needs of them is that they are two
 * distinct accounts neither trusted nor each other — which is a fact about these cases, not a
 * standing any other suite reasons about. */
const STRANGER: GithubAccount = { id: 999, login: "mallory", type: "User" };
const OTHER_STRANGER: GithubAccount = { id: 998, login: "eve", type: "User" };

describe("commit conditions", () => {
	/** What the declared count alone settles (SPEC.md §3.2), which is why neither row plans a route. */
	it.each([
		{ commits: 0, name: "is zero", reason: "no-commits" },
		{ commits: MAX_VERIFIABLE_COMMITS + 1, name: "exceeds the cap", reason: "too-many-commits" },
	])(
		"skips when the declared commit count $name, with no api call",
		async ({ commits, reason }) => {
			expect.hasAssertions();
			const session = installFetchMock([]);
			const response = await postSigned(buildPayload({ commits }));
			await expectSkipped(response, reason);
			session.assertDone();
		},
	);

	it("skips on a commit count mismatch", async () => {
		expect.hasAssertions();
		const session = installFetchMock([installTokenRoute(), commitsRouteFor([commitItem()])]);
		const response = await postSigned(buildPayload({ commits: 2 }));
		await expectSkipped(response, "commit-count-mismatch");
		session.assertDone();
	});
});

describe("commit verification", () => {
	/** The two §3.2 halves one commit can fail on: the signature, and a principal's trust. */
	it.each([
		{ commit: { verified: false }, name: "an unverified commit", reason: "unverified-commit" },
		{
			commit: { author: STRANGER },
			name: "a commit from an untrusted author",
			reason: "untrusted-commit",
		},
	])("skips $name", async ({ commit, reason }) => {
		expect.hasAssertions();
		const session = installFetchMock([installTokenRoute(), commitsRouteFor([commitItem(commit)])]);
		const response = await postSigned(buildPayload());
		await expectSkipped(response, reason);
		session.assertDone();
	});

	it("stops before any principal lookup when the first commit is unverified", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			membershipAdminRoute(OWNER),
			commitsRouteFor(
				[commitItem({ author: STRANGER, verified: false }), commitItem({ author: STRANGER })],
				ORG,
			),
		]);
		const response = await postSigned(buildPayload({ commits: 2, repoOwner: ORG }));
		await expectSkipped(response, "unverified-commit");
		session.assertDone();
	});
});

describe("principal trust resolution", () => {
	/* SPEC.md §3.1: the per-delivery memo is keyed on the account, not the login. The PR author
	 * resolves renovate[bot] to trusted without a lookup; a commit author reusing that login
	 * under another id must still be classified on its own, or the §3.1 id pinning is dead
	 * weight — every check upstream of the cache already pins it. */
	it("does not extend a trusted verdict to another id on the same login", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			commitsRouteFor([commitItem({ author: RENOVATE_WRONG_ID, committer: WEB_FLOW_USER })]),
		]);
		const response = await postSigned(buildPayload({ user: RENOVATE }));
		await expectSkipped(response, "untrusted-commit");
		session.assertDone();
	});

	/* SPEC.md §4: the subrequest budget is why lookups are lazy and sequential, so once one
	 * principal settles the commit there is nothing a second lookup could change. */
	it("stops resolving a commit's principals at the first untrusted one", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			membershipAdminRoute(OWNER),
			commitsRouteFor([commitItem({ author: STRANGER, committer: OTHER_STRANGER })], ORG),
			membershipMissingRoute(STRANGER),
		]);
		const response = await postSigned(buildPayload({ repoOwner: ORG }));
		await expectSkipped(response, "untrusted-commit");
		expect(session.requests.map((entry) => entry.url)).not.toContain(membershipUrl(OTHER_STRANGER));
		session.assertDone();
	});
});
