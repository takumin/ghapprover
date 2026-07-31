/**
 * The SPEC.md §4 pipeline driven end to end through the stubbed fetch (src/pipeline.ts): the state
 * conditions decided on the payload alone, the author's trust, the duplicate-approval check, and
 * the live TOCTOU check that guards the review POST. The §3.2 commit conditions and the failure
 * paths have suites of their own (pipeline-commits.test.ts, pipeline-failures.test.ts).
 */

import {
	APP_URL,
	COMMITS_SUFFIX,
	JWT_PATTERN,
	TOKEN,
	TOKEN_URL,
	appRoute,
	commitItem,
	commitsRoute,
	installTokenRoute,
	membershipAdminRoute,
	membershipMissingRoute,
	pullUrl,
	reviewPostRoute,
	reviewsRoute,
} from "./github-api";
import {
	AUTOFIX_CI,
	HEAD_SHA,
	ORG,
	OWNER,
	PULL_NUMBER,
	RENOVATE,
	REPOSITORY,
	WEB_FLOW_USER,
} from "./fixtures";
import {
	DELIVERY_ID,
	OWN_APPROVAL,
	buildPayload,
	captureLog,
	expectApproved,
	expectSkipped,
	happyRoutes,
	pipelineRoutes,
	postSigned,
} from "./delivery";
import { HTTP_OK, HTTP_UNPROCESSABLE_ENTITY } from "../src/http-status";
import { describe, expect, it } from "vitest";
import { installFetchMock, requestByUrl } from "./fetch-stub";

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
			overrides: { headRepo: { id: REPOSITORY.id + 1 } },
			reason: "head-repo-forked",
		},
	] as const)("skips $name without dispatching a single call", async ({ overrides, reason }) => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload(overrides));
		await expectSkipped(response, reason);
		expect(session.requests).toHaveLength(0);
	});
});

describe("owner approval flow", () => {
	it("approves the owner's pull request", async () => {
		expect.hasAssertions();
		const session = installFetchMock(happyRoutes());
		const response = await postSigned(buildPayload());
		await expectApproved(response);
		const posted = requestByUrl(session, pullUrl("/reviews"));
		expect(posted.body).toBe('{"commit_id":"head-sha","event":"APPROVE"}');
		session.assertDone();
	});

	it("splits the app jwt and the installation token across endpoints", async () => {
		expect.hasAssertions();
		const session = installFetchMock(happyRoutes());
		await postSigned(buildPayload());
		expect(requestByUrl(session, TOKEN_URL).headers["authorization"]).toMatch(JWT_PATTERN);
		expect(requestByUrl(session, APP_URL).headers["authorization"]).toMatch(JWT_PATTERN);
		expect(requestByUrl(session, pullUrl(COMMITS_SUFFIX)).headers["authorization"]).toBe(
			`token ${TOKEN}`,
		);
		expect(requestByUrl(session, pullUrl("/reviews")).headers["authorization"]).toBe(
			`token ${TOKEN}`,
		);
	});

	it("emits one structured decision log", async () => {
		expect.hasAssertions();
		const logSpy = captureLog();
		installFetchMock(happyRoutes());
		await postSigned(buildPayload());
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "opened",
				decision: "approved",
				deliveryId: DELIVERY_ID,
				headSha: HEAD_SHA,
				prNumber: PULL_NUMBER,
				repo: REPOSITORY.full_name,
			}),
		);
	});
});

describe("author trust", () => {
	it("approves an org owner author with a single membership lookup", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			membershipAdminRoute(OWNER),
			...pipelineRoutes({ commits: [commitItem()], owner: ORG, reviews: [] }),
			reviewPostRoute(HTTP_OK, ORG),
		]);
		const response = await postSigned(buildPayload({ repoOwner: ORG }));
		await expectApproved(response);
		session.assertDone();
	});

	it("skips when the membership lookup returns 404", async () => {
		expect.hasAssertions();
		const session = installFetchMock([installTokenRoute(), membershipMissingRoute(OWNER)]);
		const response = await postSigned(buildPayload({ repoOwner: ORG }));
		await expectSkipped(response, "author-not-trusted");
		session.assertDone();
	});

	it("approves an allowlisted renovate bot author", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			...pipelineRoutes({
				commits: [commitItem({ author: RENOVATE, committer: WEB_FLOW_USER })],
				reviews: [],
			}),
			reviewPostRoute(HTTP_OK),
		]);
		const response = await postSigned(buildPayload({ user: RENOVATE }));
		await expectApproved(response);
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
				reviews: [],
			}),
			reviewPostRoute(HTTP_OK),
		]);
		const response = await postSigned(buildPayload({ commits: 2, user: RENOVATE }));
		await expectApproved(response);
		session.assertDone();
	});
});

describe("duplicate approval check", () => {
	it("skips when its own approval already exists", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			commitsRoute([commitItem()]),
			appRoute(),
			reviewsRoute([OWN_APPROVAL]),
		]);
		const response = await postSigned(buildPayload());
		await expectSkipped(response, "already-approved");
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
				reviews: [],
			}),
		]);
		const response = await postSigned(buildPayload());
		await expectSkipped(response, "head-moved");
		session.assertDone();
	});

	it("skips when the review post is rejected", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			installTokenRoute(),
			...pipelineRoutes({ commits: [commitItem()], reviews: [] }),
			reviewPostRoute(HTTP_UNPROCESSABLE_ENTITY),
		]);
		const response = await postSigned(buildPayload());
		await expectSkipped(response, "review-rejected");
		session.assertDone();
	});
});
