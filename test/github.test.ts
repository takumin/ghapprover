/**
 * The GitHub endpoints themselves (src/github.ts): what each call sends, how many pages it
 * follows, and how the response is mapped onto the frozen contract — a malformed item is a broken
 * API contract and throws (SPEC.md §9). What every call shares regardless of endpoint — auth, the
 * delivery budget, and failure attribution — is driven by client.test.ts.
 */

import {
	APP_ENDPOINT,
	COMMITS_ENDPOINT,
	HTTP_FORBIDDEN,
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	HTTP_OK,
	HTTP_UNPROCESSABLE_ENTITY,
	PULL_NUMBER,
	REVIEW_POST_ENDPOINT,
	installFetchMock,
	jsonRoute,
	requestByUrl,
} from "./fetch-stub";
import {
	FULL_PAGE,
	MEMBERSHIP_ORG,
	MEMBERSHIP_USER,
	REPO,
	TOKENS_URL,
	appRoute,
	approvalTarget,
	commitBody,
	commitPage,
	commitsUrl,
	installTokenRoute,
	linkedRoute,
	makeClient,
	membershipRoute,
	pullUrl,
	reviewPostRoute,
	reviewsPostUrl,
	reviewsUrl,
} from "./github-routes";
import {
	createApprovalReview,
	fetchAppBotLogin,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "../src/github";
import { describe, expect, it } from "vitest";
import { GithubApiError } from "../src/api-error";
import { OCTO } from "./accounts";

const SECOND_PAGE_COUNT = 37;

function reviewBody(commitId: string): Record<string, unknown> {
	return { commit_id: commitId, state: "APPROVED", user: OCTO };
}

describe("fetchAppBotLogin()", () => {
	it("returns the bot login for the slug without issuing an installation token", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute()]);
		await expect(fetchAppBotLogin(await makeClient())).resolves.toBe("my-app[bot]");
		mock.assertDone();
	});

	it("throws GithubApiError when the slug is missing", async () => {
		expect.hasAssertions();
		installFetchMock([appRoute({ id: 1 })]);
		const promise = fetchAppBotLogin(await makeClient());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: APP_ENDPOINT, status: HTTP_OK });
	});
});

describe("listPullRequestCommits() pagination", () => {
	it("follows the link header across two pages", async () => {
		expect.hasAssertions();
		const firstUrl = commitsUrl();
		const secondUrl = commitsUrl("&page=2");
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({ next: secondUrl, payload: commitPage(FULL_PAGE, 0), url: firstUrl }),
			linkedRoute({ payload: commitPage(SECOND_PAGE_COUNT, FULL_PAGE), url: secondUrl }),
		]);
		const commits = await listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		expect(commits).toHaveLength(FULL_PAGE + SECOND_PAGE_COUNT);
		expect(commits.at(-1)).toMatchObject({ sha: "sha-136" });
		expect(mock.requests.map((seen) => seen.url)).toStrictEqual([TOKENS_URL, firstUrl, secondUrl]);
		mock.assertDone();
	});
});

describe("listPullRequestCommits() mapping", () => {
	it("maps fields and stops on a page without a link header", async () => {
		expect.hasAssertions();
		const webCommit = {
			author: null,
			commit: { extra: true, verification: { reason: "valid", verified: true } },
			committer: OCTO,
			sha: "sha-web",
		};
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({ payload: [commitBody("sha-a"), webCommit], url: commitsUrl() }),
		]);
		const commits = await listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		expect(commits).toStrictEqual([
			{
				author: OCTO,
				commit: { verification: { verified: true } },
				committer: OCTO,
				sha: "sha-a",
			},
			{
				author: null,
				commit: { verification: { verified: true } },
				committer: OCTO,
				sha: "sha-web",
			},
		]);
		mock.assertDone();
	});

	it("throws GithubApiError on a malformed commit item", async () => {
		expect.hasAssertions();
		installFetchMock([
			installTokenRoute(),
			linkedRoute({
				payload: [{ commit: { verification: { verified: true } } }],
				url: commitsUrl(),
			}),
		]);
		const promise = listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: COMMITS_ENDPOINT, status: HTTP_OK });
	});
});

describe("fetchOrgMembership()", () => {
	it("maps an active admin membership", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			installTokenRoute(),
			membershipRoute({ organization_url: "ignored", role: "admin", state: "active" }, HTTP_OK),
		]);
		await expect(
			fetchOrgMembership(await makeClient(), MEMBERSHIP_ORG, MEMBERSHIP_USER),
		).resolves.toStrictEqual({
			role: "admin",
			state: "active",
		});
		mock.assertDone();
	});

	it("returns null on 404", async () => {
		expect.hasAssertions();
		installFetchMock([installTokenRoute(), membershipRoute({ message: "no" }, HTTP_NOT_FOUND)]);
		await expect(
			fetchOrgMembership(await makeClient(), MEMBERSHIP_ORG, MEMBERSHIP_USER),
		).resolves.toBeNull();
	});

	it("throws with the status on 403", async () => {
		expect.hasAssertions();
		installFetchMock([installTokenRoute(), membershipRoute({ message: "no" }, HTTP_FORBIDDEN)]);
		const promise = fetchOrgMembership(await makeClient(), MEMBERSHIP_ORG, MEMBERSHIP_USER);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ status: HTTP_FORBIDDEN });
	});
});

describe("listPullRequestReviews()", () => {
	it("follows the link header until the last page", async () => {
		expect.hasAssertions();
		const firstUrl = reviewsUrl();
		const secondUrl = reviewsUrl("&page=2");
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({
				next: secondUrl,
				payload: Array.from({ length: FULL_PAGE }, (_, index) => reviewBody(`rev-${index}`)),
				url: firstUrl,
			}),
			linkedRoute({ payload: [reviewBody("rev-tail")], url: secondUrl }),
		]);
		const reviews = await listPullRequestReviews(await makeClient(), REPO, PULL_NUMBER);
		expect(reviews).toHaveLength(FULL_PAGE + 1);
		expect(mock.requests.map((seen) => seen.url)).toStrictEqual([TOKENS_URL, firstUrl, secondUrl]);
	});

	it("maps null user and null commit_id", async () => {
		expect.hasAssertions();
		const dismissed = { commit_id: null, state: "DISMISSED", submitted_at: "ignored", user: null };
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({ payload: [dismissed], url: reviewsUrl() }),
		]);
		await expect(
			listPullRequestReviews(await makeClient(), REPO, PULL_NUMBER),
		).resolves.toStrictEqual([{ commit_id: null, state: "DISMISSED", user: null }]);
		mock.assertDone();
	});
});

describe("fetchPullRequest()", () => {
	it("maps only the contract fields", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			installTokenRoute(),
			jsonRoute({
				method: "GET",
				payload: { draft: false, head: { label: "octo:main", sha: "live-sha" }, state: "open" },
				status: HTTP_OK,
				url: pullUrl(),
			}),
		]);
		await expect(fetchPullRequest(await makeClient(), REPO, PULL_NUMBER)).resolves.toStrictEqual({
			draft: false,
			head: { sha: "live-sha" },
			state: "open",
		});
		mock.assertDone();
	});
});

describe("createApprovalReview()", () => {
	it("returns created on 200 and posts commit_id with APPROVE", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([installTokenRoute(), reviewPostRoute({ id: 1 }, HTTP_OK)]);
		await expect(createApprovalReview(await makeClient(), approvalTarget())).resolves.toBe(
			"created",
		);
		const posted = requestByUrl(mock, reviewsPostUrl());
		expect(posted).toMatchObject({ body: '{"commit_id":"head-sha","event":"APPROVE"}' });
		expect(posted.headers["content-type"]).toMatch(/application\/json/u);
	});

	it("returns rejected on 422", async () => {
		expect.hasAssertions();
		installFetchMock([
			installTokenRoute(),
			reviewPostRoute({ message: "closed" }, HTTP_UNPROCESSABLE_ENTITY),
		]);
		await expect(createApprovalReview(await makeClient(), approvalTarget())).resolves.toBe(
			"rejected",
		);
	});

	it("throws GithubApiError on 500", async () => {
		expect.hasAssertions();
		installFetchMock([
			installTokenRoute(),
			reviewPostRoute({ message: "boom" }, HTTP_INTERNAL_ERROR),
		]);
		const promise = createApprovalReview(await makeClient(), approvalTarget());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			endpoint: REVIEW_POST_ENDPOINT,
			status: HTTP_INTERNAL_ERROR,
		});
	});
});
