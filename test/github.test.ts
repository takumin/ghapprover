/**
 * The GitHub endpoints themselves (src/github.ts): what each call sends, how many pages it
 * follows, and how the response is mapped onto the frozen contract — a malformed item is a broken
 * API contract and throws (SPEC.md §9). What every call shares regardless of endpoint — auth, the
 * delivery budget, and failure attribution — is driven by client.test.ts.
 */

import { APP_BOT, HUMAN, ORG, OWNER, PULL_NUMBER } from "./fixtures";
import {
	APP_ENDPOINT,
	COMMITS_ENDPOINT,
	COMMITS_SUFFIX,
	HTTP_FORBIDDEN,
	NEXT_PAGE,
	REPO,
	REVIEWS_SUFFIX,
	REVIEW_POST_ENDPOINT,
	TOKEN_URL,
	appRoute,
	approvalTarget,
	commitItem,
	commitPage,
	getRoute,
	installTokenRoute,
	linkedRoute,
	makeClient,
	membershipRoute,
	pullUrl,
	reviewPostRoute,
} from "./github-api";
import {
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	HTTP_OK,
	HTTP_UNPROCESSABLE_ENTITY,
} from "~src/http-status";
import {
	PAGE_SIZE,
	createApprovalReview,
	fetchAppBotLogin,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
	resetAppBotLogin,
} from "~src/github";
import { beforeEach, describe, expect, it } from "vitest";
import { installFetchMock, requestByUrl } from "./fetch-stub";
import { GithubApiError } from "~src/api-error";

const SECOND_PAGE_COUNT = 37;

function reviewBody(commitId: string): Record<string, unknown> {
	return { commit_id: commitId, state: "APPROVED", user: OWNER };
}

/* The derived login is cached for the isolate (SPEC.md §4), so it outlives the case that filled
 * it: a case served a login no route of its own answered is one that passes without making the
 * call it is about. The state is the module's, which is why the hook is the file's. */
// oxlint-disable-next-line vitest/no-hooks, vitest/require-top-level-describe -- see above
beforeEach(resetAppBotLogin);

describe("fetchAppBotLogin()", () => {
	it("returns the bot login without issuing an installation token", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute()]);
		await expect(fetchAppBotLogin(await makeClient())).resolves.toBe(APP_BOT.login);
		mock.assertDone();
	});

	it("throws GithubApiError when the slug is missing", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([appRoute({ id: 1 })]);
		const promise = fetchAppBotLogin(await makeClient());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: APP_ENDPOINT, status: HTTP_OK });
	});
});

/* SPEC.md §4: the slug is fixed for the deployment, so what the cache is asserted on is the call
 * it removes — one GET /app for however many deliveries the isolate goes on to serve. */
describe("fetchAppBotLogin() caching", () => {
	it("derives the login once for the isolate", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute()]);
		await expect(fetchAppBotLogin(await makeClient())).resolves.toBe(APP_BOT.login);
		await expect(fetchAppBotLogin(await makeClient())).resolves.toBe(APP_BOT.login);
		expect(mock.requests).toHaveLength(1);
	});

	/* The window a cache of the resolved login leaves open: both calls are started before either is
	 * awaited, so what closes it is holding the lookup itself rather than what it returns. */
	it("shares one lookup with a concurrent call", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute()]);
		const client = await makeClient();
		const logins = await Promise.all([fetchAppBotLogin(client), fetchAppBotLogin(client)]);
		expect(logins).toStrictEqual([APP_BOT.login, APP_BOT.login]);
		expect(mock.requests).toHaveLength(1);
	});

	/* A rejection is not retained: a stored failure would be served to every later delivery too. */
	it("fetches again after a failed call", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute({}), appRoute()]);
		await expect(fetchAppBotLogin(await makeClient())).rejects.toBeInstanceOf(GithubApiError);
		await expect(fetchAppBotLogin(await makeClient())).resolves.toBe(APP_BOT.login);
		mock.assertDone();
	});
});

describe("listPullRequestCommits() pagination", () => {
	it("follows the link header across two pages", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const firstUrl = pullUrl(COMMITS_SUFFIX);
		const secondUrl = pullUrl(`${COMMITS_SUFFIX}${NEXT_PAGE}`);
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({ next: secondUrl, payload: commitPage(PAGE_SIZE, 0), url: firstUrl }),
			linkedRoute({ payload: commitPage(SECOND_PAGE_COUNT, PAGE_SIZE), url: secondUrl }),
		]);
		const commits = await listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		expect(commits).toHaveLength(PAGE_SIZE + SECOND_PAGE_COUNT);
		expect(commits.at(-1)).toMatchObject({ sha: "sha-136" });
		expect(mock.requests.map((seen) => seen.url)).toStrictEqual([TOKEN_URL, firstUrl, secondUrl]);
		mock.assertDone();
	});
});

describe("listPullRequestCommits() mapping", () => {
	it("maps fields and stops on a page without a link header", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const webCommit = {
			author: null,
			commit: { extra: true, verification: { reason: "valid", verified: true } },
			committer: OWNER,
			sha: "sha-web",
		};
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({
				payload: [commitItem({ sha: "sha-a" }), webCommit],
				url: pullUrl(COMMITS_SUFFIX),
			}),
		]);
		const commits = await listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		expect(commits).toStrictEqual([
			{
				author: OWNER,
				commit: { verification: { verified: true } },
				committer: OWNER,
				sha: "sha-a",
			},
			{
				author: null,
				commit: { verification: { verified: true } },
				committer: OWNER,
				sha: "sha-web",
			},
		]);
		mock.assertDone();
	});

	it("throws GithubApiError on a malformed commit item", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([
			installTokenRoute(),
			linkedRoute({
				payload: [{ commit: { verification: { verified: true } } }],
				url: pullUrl(COMMITS_SUFFIX),
			}),
		]);
		const promise = listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: COMMITS_ENDPOINT, status: HTTP_OK });
	});
});

describe("fetchOrgMembership()", () => {
	it("maps an active admin membership", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			installTokenRoute(),
			membershipRoute(
				HUMAN,
				{ organization_url: "ignored", role: "admin", state: "active" },
				HTTP_OK,
			),
		]);
		const membership = fetchOrgMembership(await makeClient(), ORG.login, HUMAN.login);
		await expect(membership).resolves.toStrictEqual({ role: "admin", state: "active" });
		mock.assertDone();
	});

	it("returns no membership on 404", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([
			installTokenRoute(),
			membershipRoute(HUMAN, { message: "no" }, HTTP_NOT_FOUND),
		]);
		const membership = fetchOrgMembership(await makeClient(), ORG.login, HUMAN.login);
		await expect(membership).resolves.toBeUndefined();
	});

	it("throws with the status on 403", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([
			installTokenRoute(),
			membershipRoute(HUMAN, { message: "no" }, HTTP_FORBIDDEN),
		]);
		const promise = fetchOrgMembership(await makeClient(), ORG.login, HUMAN.login);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ status: HTTP_FORBIDDEN });
	});
});

describe("listPullRequestReviews()", () => {
	it("follows the link header until the last page", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const firstUrl = pullUrl(REVIEWS_SUFFIX);
		const secondUrl = pullUrl(`${REVIEWS_SUFFIX}${NEXT_PAGE}`);
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({
				next: secondUrl,
				payload: Array.from({ length: PAGE_SIZE }, (_, index) => reviewBody(`rev-${index}`)),
				url: firstUrl,
			}),
			linkedRoute({ payload: [reviewBody("rev-tail")], url: secondUrl }),
		]);
		const reviews = await listPullRequestReviews(await makeClient(), REPO, PULL_NUMBER);
		expect(reviews).toHaveLength(PAGE_SIZE + 1);
		expect(mock.requests.map((seen) => seen.url)).toStrictEqual([TOKEN_URL, firstUrl, secondUrl]);
	});

	it("maps null user and null commit_id", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const dismissed = { commit_id: null, state: "DISMISSED", submitted_at: "ignored", user: null };
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({ payload: [dismissed], url: pullUrl(REVIEWS_SUFFIX) }),
		]);
		const reviews = await listPullRequestReviews(await makeClient(), REPO, PULL_NUMBER);
		expect(reviews).toStrictEqual([{ commit_id: null, state: "DISMISSED", user: null }]);
		mock.assertDone();
	});
});

describe("fetchPullRequest()", () => {
	it("maps only the contract fields", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			installTokenRoute(),
			/* The extra `label` is what this case is about: the contract must strip it, so the
			 * body is stated here rather than taken from the shared live-PR route. */
			getRoute(pullUrl(), {
				draft: false,
				head: { label: "octo:main", sha: "live-sha" },
				state: "open",
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
	it("returns created on 200 and posts commit_id with APPROVE", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const mock = installFetchMock([installTokenRoute(), reviewPostRoute(HTTP_OK)]);
		const created = await createApprovalReview(await makeClient(), approvalTarget());
		expect(created).toBe("created");
		const posted = requestByUrl(mock, pullUrl("/reviews"));
		expect(posted).toMatchObject({ body: '{"commit_id":"head-sha","event":"APPROVE"}' });
		expect(posted.headers["content-type"]).toMatch(/application\/json/u);
	});

	it("returns rejected on 422", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([installTokenRoute(), reviewPostRoute(HTTP_UNPROCESSABLE_ENTITY)]);
		await expect(createApprovalReview(await makeClient(), approvalTarget())).resolves.toBe(
			"rejected",
		);
	});

	it("throws GithubApiError on 500", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		installFetchMock([installTokenRoute(), reviewPostRoute(HTTP_INTERNAL_ERROR)]);
		const promise = createApprovalReview(await makeClient(), approvalTarget());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			endpoint: REVIEW_POST_ENDPOINT,
			status: HTTP_INTERNAL_ERROR,
		});
	});
});
