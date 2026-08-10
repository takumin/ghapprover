/**
 * The SPEC.md §3.2 commit conditions driven through the whole pipeline: what the declared count
 * settles before a single call, what the fetched list settles before any lookup, and how far the
 * per-commit walk gets before a failing commit ends it. The lookups a run does *not* make are as
 * much the assertion as the ones it does — that bound is what keeps a skip from bursting one
 * membership lookup per commit (SPEC.md §3.1, §4).
 */

import { ORG, OWNER, RENOVATE, RENOVATE_WRONG_ID, WEB_FLOW_USER } from "./fixtures";
import {
	buildPayload,
	expectApproved,
	expectSkipped,
	pipelineRoutes,
	postSigned,
} from "./delivery";
import {
	commitItem,
	commitsRoute,
	installTokenRoute,
	membershipAdminRoute,
	membershipMissingRoute,
	membershipUrl,
	reviewPostRoute,
} from "./github-api";
import { describe, expect, it } from "vitest";
import type { GithubAccount } from "~src/types";
import { HTTP_OK } from "~src/http-status";
import { MAX_VERIFIABLE_COMMITS } from "~src/commits";
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
	] as const)(
		"skips when the declared commit count $name, with no api call",
		{ timeout: 5000 },
		async ({ commits, reason }) => {
			expect.hasAssertions();
			const session = installFetchMock([]);
			const response = await postSigned(buildPayload({ commits }));
			await expectSkipped(response, reason);
			session.assertDone();
		},
	);

	it("skips on a commit count mismatch", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const session = installFetchMock([installTokenRoute(), commitsRoute([commitItem()])]);
		const response = await postSigned(buildPayload({ commits: 2 }));
		await expectSkipped(response, "commit-count-mismatch");
		session.assertDone();
	});
});

describe("commit verification", () => {
	/** The two §3.2 halves one commit can fail on: the signature, and its principal's trust. */
	it.each([
		{ commit: { verified: false }, name: "an unverified commit", reason: "unverified-commit" },
		{
			commit: { committer: STRANGER },
			name: "a commit from an untrusted committer",
			reason: "untrusted-commit",
		},
	] as const)("skips $name", { timeout: 5000 }, async ({ commit, reason }) => {
		expect.hasAssertions();
		const session = installFetchMock([installTokenRoute(), commitsRoute([commitItem(commit)])]);
		const response = await postSigned(buildPayload());
		await expectSkipped(response, reason);
		session.assertDone();
	});

	it(
		"stops before any principal lookup when the first commit is unverified",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const session = installFetchMock([
				installTokenRoute(),
				membershipAdminRoute(OWNER),
				commitsRoute(
					[
						commitItem({ committer: STRANGER, verified: false }),
						commitItem({ committer: STRANGER }),
					],
					ORG,
				),
			]);
			const response = await postSigned(buildPayload({ commits: 2, repoOwner: ORG }));
			await expectSkipped(response, "unverified-commit");
			session.assertDone();
		},
	);
});

describe("commit custody", () => {
	/* Where custody and authorship come apart, which is the case §3.2 is decided by: a commit the
	 * owner signed onto their own branch and an untrusted account authored — a patch applied on a
	 * contributor's behalf, a rebase, a tool's commit. The signature binds the committer, so this
	 * approves; the same run is refused above once the untrusted account is the committer instead,
	 * and that pair is the whole of the condition's shape. */
	it(
		"approves a commit a trusted principal committed for an untrusted author",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const session = installFetchMock([
				installTokenRoute(),
				...pipelineRoutes({ commits: [commitItem({ author: STRANGER })], reviews: [] }),
				reviewPostRoute(HTTP_OK),
			]);
			const response = await postSigned(buildPayload());
			await expectApproved(response);
			session.assertDone();
		},
	);
});

describe("principal trust resolution", () => {
	/* SPEC.md §3.1: the per-delivery memo is keyed on the account, not the login. The PR author
	 * resolves renovate[bot] to trusted without a lookup; the commit below is GitHub-signed, so
	 * §3.2 decides it on its author, and an author reusing that login under another id must still
	 * be classified on its own — or the §3.1 id pinning is dead weight, every check upstream of the
	 * cache already pinning it. */
	it(
		"does not extend a trusted verdict to another id on the same login",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const session = installFetchMock([
				installTokenRoute(),
				commitsRoute([commitItem({ author: RENOVATE_WRONG_ID, committer: WEB_FLOW_USER })]),
			]);
			const response = await postSigned(buildPayload({ user: RENOVATE }));
			await expectSkipped(response, "untrusted-commit");
			session.assertDone();
		},
	);

	/* SPEC.md §3.2: the committer is the whole of what a commit is decided on outside the web-flow
	 * case, so the author is not a second account to resolve. Asserting the lookup that does not
	 * happen is what pins that — a run that resolved both would reach the same skip here. */
	it(
		"resolves a commit on its committer without looking its author up",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const session = installFetchMock([
				installTokenRoute(),
				membershipAdminRoute(OWNER),
				commitsRoute([commitItem({ author: STRANGER, committer: OTHER_STRANGER })], ORG),
				membershipMissingRoute(OTHER_STRANGER),
			]);
			const response = await postSigned(buildPayload({ repoOwner: ORG }));
			await expectSkipped(response, "untrusted-commit");
			expect(session.requests.map((entry) => entry.url)).not.toContain(membershipUrl(STRANGER));
			session.assertDone();
		},
	);
});
