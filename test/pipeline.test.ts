/**
 * The SPEC.md §4 pipeline driven end to end through the stubbed fetch (src/pipeline.ts): the state
 * conditions decided on the payload alone, the author's trust, the duplicate-approval check, and
 * the live TOCTOU check that guards the review POST. The §3.2 commit conditions and the failure
 * paths have suites of their own (pipeline-commits.test.ts, pipeline-failures.test.ts).
 */

import {
	APP_URL,
	COMMITS_SUFFIX,
	DELIVERY_ID,
	HEAD_SHA,
	ORG,
	OWN_APPROVAL,
	PULL_NUMBER,
	REPO_ID,
	TOKEN_URL,
	appRoute,
	buildPayload,
	commitItem,
	commitsRouteFor,
	expectReply,
	happyRoutes,
	installTokenRoute,
	membershipAdminRoute,
	membershipMissingRoute,
	pipelineRoutes,
	postSigned,
	pullsUrl,
	reviewPostRoute,
	reviewsRouteFor,
} from "./delivery";
import { AUTOFIX_CI, RENOVATE, WEB_FLOW_USER } from "./accounts";
import {
	HTTP_OK,
	HTTP_UNPROCESSABLE_ENTITY,
	JWT_PATTERN,
	installFetchMock,
	requestByUrl,
} from "./fetch-stub";
import { describe, expect, it, vi } from "vitest";

/* SPEC.md §4 step 2: the state conditions are decided on the payload alone, so each of them
 * settles the delivery before the client is built — which is what the request count asserts. */
describe("pull request state", () => {
	it.each([
		{ name: "a draft pull request", overrides: { draft: true }, reason: "pr-draft" },
		{ name: "a closed pull request", overrides: { state: "closed" }, reason: "pr-not-open" },
		{
			name: "a deleted head repository",
			overrides: { headRepo: null },
			reason: "head-repo-missing",
		},
		{
			name: "a fork pull request",
			overrides: { headRepo: { id: REPO_ID + 1 } },
			reason: "head-repo-forked",
		},
	])("skips $name without dispatching a single call", async ({ overrides, reason }) => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload(overrides));
		await expectReply(response, { body: { decision: "skipped", reason }, status: HTTP_OK });
		expect(session.requests).toHaveLength(0);
	});
});

describe("owner approval flow", () => {
	it("approves the owner's pull request", async () => {
		expect.hasAssertions();
		const session = installFetchMock(happyRoutes());
		const response = await postSigned(buildPayload());
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
		const posted = requestByUrl(session, pullsUrl("octo", "/reviews"));
		expect(posted.body).toBe('{"commit_id":"head-sha","event":"APPROVE"}');
		session.assertDone();
	});

	it("splits the app jwt and the installation token across endpoints", async () => {
		expect.hasAssertions();
		const session = installFetchMock(happyRoutes());
		await postSigned(buildPayload());
		expect(requestByUrl(session, TOKEN_URL).headers["authorization"]).toMatch(JWT_PATTERN);
		expect(requestByUrl(session, APP_URL).headers["authorization"]).toMatch(JWT_PATTERN);
		expect(requestByUrl(session, pullsUrl("octo", COMMITS_SUFFIX)).headers["authorization"]).toBe(
			"token install-token",
		);
		expect(requestByUrl(session, pullsUrl("octo", "/reviews")).headers["authorization"]).toBe(
			"token install-token",
		);
	});

	it("emits one structured decision log", async () => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
		installFetchMock(happyRoutes());
		await postSigned(buildPayload());
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "opened",
				decision: "approved",
				deliveryId: DELIVERY_ID,
				headSha: HEAD_SHA,
				prNumber: PULL_NUMBER,
				repo: "octo/hello",
			}),
		);
		logSpy.mockRestore();
	});
});

describe("author trust", () => {
	it("approves an org owner author with a single membership lookup", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			membershipAdminRoute("octo"),
			...pipelineRoutes({ commits: [commitItem()], owner: "acme", reviews: [] }),
			reviewPostRoute("acme", HTTP_OK),
		]);
		const response = await postSigned(buildPayload({ repoOwner: ORG }));
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
		session.assertDone();
	});

	it("skips when the membership lookup returns 404", async () => {
		expect.hasAssertions();
		const session = installFetchMock([installTokenRoute(), membershipMissingRoute("octo")]);
		const response = await postSigned(buildPayload({ repoOwner: ORG }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "author-not-trusted" },
			status: HTTP_OK,
		});
		session.assertDone();
	});

	it("approves an allowlisted renovate bot author", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			...pipelineRoutes({
				commits: [commitItem({ author: RENOVATE, committer: WEB_FLOW_USER })],
				owner: "octo",
				reviews: [],
			}),
			reviewPostRoute("octo", HTTP_OK),
		]);
		const response = await postSigned(buildPayload({ user: RENOVATE }));
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
		session.assertDone();
	});
});

/* The shape autofix.ci pushes onto a bot PR (author autofix-ci[bot], committer web-flow,
 * GitHub-signed): without the allowlist entry this commit makes the PR permanently
 * unapprovable, which is exactly the PR ghapprover exists to approve (SPEC.md §3.1). */
describe("autofix.ci commits", () => {
	it("approves a renovate pull request carrying an autofix.ci commit", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			...pipelineRoutes({
				commits: [
					commitItem({ author: RENOVATE, committer: WEB_FLOW_USER }),
					commitItem({ author: AUTOFIX_CI, committer: WEB_FLOW_USER }),
				],
				owner: "octo",
				reviews: [],
			}),
			reviewPostRoute("octo", HTTP_OK),
		]);
		const response = await postSigned(buildPayload({ commits: 2, user: RENOVATE }));
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
		session.assertDone();
	});
});

describe("duplicate approval check", () => {
	it("skips when its own approval already exists", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			commitsRouteFor("octo", [commitItem()]),
			appRoute(),
			reviewsRouteFor("octo", [OWN_APPROVAL]),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "skipped", reason: "already-approved" },
			status: HTTP_OK,
		});
		session.assertDone();
	});
});

describe("live state checks", () => {
	it("skips when the head moved", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			...pipelineRoutes({
				commits: [commitItem()],
				liveSha: "moved-sha",
				owner: "octo",
				reviews: [],
			}),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "skipped", reason: "head-moved" },
			status: HTTP_OK,
		});
		session.assertDone();
	});

	it("skips when the review post is rejected", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			...pipelineRoutes({ commits: [commitItem()], owner: "octo", reviews: [] }),
			reviewPostRoute("octo", HTTP_UNPROCESSABLE_ENTITY),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "skipped", reason: "review-rejected" },
			status: HTTP_OK,
		});
		session.assertDone();
	});
});
