/* oxlint-disable max-lines -- exhaustive coverage of the six-endpoint client in one deliverable file */
import {
	GithubApiError,
	createApprovalReview,
	createGithubClient,
	fetchAppBotLogin,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "../src/github";
import { JWT_PATTERN, installFetchMock, jsonRoute, requestByUrl, tokenRoute } from "./fetch-stub";
import type { PlannedRoute, RecordedRequest } from "./fetch-stub";
import { describe, expect, it } from "vitest";
import type { GithubClient } from "../src/github";
import { privateKeyPemOnce } from "./app-key";

const BASE = "https://api.github.com";
const REPO = { owner: "octo", repo: "hello" };
const TOKEN = "installation-token";
const PULL_NUMBER = 5;
const INSTALLATION_ID = 12_345;
const TOKENS_URL = `${BASE}/app/installations/${INSTALLATION_ID}/access_tokens`;
const APP_URL = `${BASE}/app`;
const FULL_PAGE = 100;
const SECOND_PAGE_COUNT = 37;
const ACCOUNT = { id: 7, login: "octo", type: "User" };
const HTTP_OK = 200;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_ERROR = 500;

async function makeClient(): Promise<GithubClient> {
	return createGithubClient(
		{ appId: "12345", privateKeyPem: await privateKeyPemOnce() },
		INSTALLATION_ID,
	);
}

/** The lazily issued installation token consumed by installation-authed calls. */
function installTokenRoute(): PlannedRoute {
	return tokenRoute({ token: TOKEN, url: TOKENS_URL });
}
const APP_BODY = { slug: "my-app" };
/** A 200 GET /app; the payload is overridden only where the test is about a malformed response. */
function appRoute(payload: unknown = APP_BODY): PlannedRoute {
	return jsonRoute({ method: "GET", payload, status: HTTP_OK, url: APP_URL });
}

function commitBody(sha: string): Record<string, unknown> {
	return { author: ACCOUNT, commit: { verification: { verified: true } }, committer: ACCOUNT, sha };
}
function commitPage(count: number, offset: number): Record<string, unknown>[] {
	return Array.from({ length: count }, (_, index) => commitBody(`sha-${offset + index}`));
}
function reviewBody(commitId: string): Record<string, unknown> {
	return { commit_id: commitId, state: "APPROVED", user: ACCOUNT };
}
function commitsUrl(query: string): string {
	return `${BASE}/repos/octo/hello/pulls/5/commits${query}`;
}
function reviewsUrl(query: string): string {
	return `${BASE}/repos/octo/hello/pulls/5/reviews${query}`;
}
/** The link header pagination follows; absent on the last page, which is how it stops. */
function linkHeaders(next: string | undefined): Record<string, string> | undefined {
	if (next === undefined) {
		return undefined;
	}
	return { link: `<${next}>; rel="next"` };
}
/** A page response whose link header points pagination at the next page, when there is one. */
function linkedRoute(route: {
	readonly next?: string;
	readonly payload: unknown;
	readonly url: string;
}): PlannedRoute {
	return jsonRoute({
		headers: linkHeaders(route.next),
		method: "GET",
		payload: route.payload,
		status: HTTP_OK,
		url: route.url,
	});
}

describe("fetchAppBotLogin()", () => {
	it("returns the bot login for the slug without issuing an installation token", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute()]);
		await expect(fetchAppBotLogin(await makeClient())).resolves.toBe("my-app[bot]");
		mock.assertDone();
	});

	it("authenticates with the app jwt and sends the pinned api version", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute()]);
		await fetchAppBotLogin(await makeClient());
		const seen = requestByUrl(mock, APP_URL);
		expect(seen.headers["authorization"]).toMatch(JWT_PATTERN);
		expect(seen.headers["x-github-api-version"]).toBe("2022-11-28");
		expect(seen.headers["user-agent"]).toMatch(/^ghapprover /u);
	});

	it("throws GithubApiError when the slug is missing", async () => {
		expect.hasAssertions();
		installFetchMock([appRoute({ id: 1 })]);
		const promise = fetchAppBotLogin(await makeClient());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: "GET /app", status: HTTP_OK });
	});
});

describe("transport failure mapping", () => {
	it("wraps network failures with status 0", async () => {
		expect.hasAssertions();
		installFetchMock([jsonRoute({ method: "GET", payload: {}, status: 0, url: APP_URL })]);
		const promise = fetchAppBotLogin(await makeClient());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: "GET /app", status: 0 });
	});

	it("wraps an expired timeout signal with status 0", async () => {
		expect.hasAssertions();
		installFetchMock([{ body: "", method: "GET", rejectAs: "timeout", status: 0, url: APP_URL }]);
		const promise = fetchAppBotLogin(await makeClient());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: "GET /app", status: 0 });
	});
});

describe("listPullRequestCommits() pagination", () => {
	it("follows the link header across two pages", async () => {
		expect.hasAssertions();
		const firstUrl = commitsUrl("?per_page=100");
		const secondUrl = commitsUrl("?per_page=100&page=2");
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

	it("authenticates with the installation token", async () => {
		expect.hasAssertions();
		const firstUrl = commitsUrl("?per_page=100");
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({ payload: [commitBody("sha-a")], url: firstUrl }),
		]);
		await listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		expect(requestByUrl(mock, firstUrl).headers["authorization"]).toBe(`token ${TOKEN}`);
	});
});

describe("listPullRequestCommits() mapping", () => {
	it("maps fields and stops on a page without a link header", async () => {
		expect.hasAssertions();
		const webCommit = {
			author: null,
			commit: { extra: true, verification: { reason: "valid", verified: true } },
			committer: ACCOUNT,
			sha: "sha-web",
		};
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({ payload: [commitBody("sha-a"), webCommit], url: commitsUrl("?per_page=100") }),
		]);
		const commits = await listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		expect(commits).toStrictEqual([
			{
				author: ACCOUNT,
				commit: { verification: { verified: true } },
				committer: ACCOUNT,
				sha: "sha-a",
			},
			{
				author: null,
				commit: { verification: { verified: true } },
				committer: ACCOUNT,
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
				url: commitsUrl("?per_page=100"),
			}),
		]);
		const promise = listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			endpoint: "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits",
			status: HTTP_OK,
		});
	});
});

const MEMBERSHIP_URL = `${BASE}/orgs/octo/memberships/someone`;
function membershipRoute(payload: unknown, status: number): PlannedRoute {
	return jsonRoute({ method: "GET", payload, status, url: MEMBERSHIP_URL });
}

describe("fetchOrgMembership()", () => {
	it("maps an active admin membership", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			installTokenRoute(),
			membershipRoute({ organization_url: "ignored", role: "admin", state: "active" }, HTTP_OK),
		]);
		await expect(fetchOrgMembership(await makeClient(), "octo", "someone")).resolves.toStrictEqual({
			role: "admin",
			state: "active",
		});
		mock.assertDone();
	});

	it("returns null on 404", async () => {
		expect.hasAssertions();
		installFetchMock([installTokenRoute(), membershipRoute({ message: "no" }, HTTP_NOT_FOUND)]);
		await expect(fetchOrgMembership(await makeClient(), "octo", "someone")).resolves.toBeNull();
	});

	it("throws with the status on 403", async () => {
		expect.hasAssertions();
		installFetchMock([installTokenRoute(), membershipRoute({ message: "no" }, HTTP_FORBIDDEN)]);
		const promise = fetchOrgMembership(await makeClient(), "octo", "someone");
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ status: HTTP_FORBIDDEN });
	});

	it("does not mistake a token-issuance 404 for a missing membership", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({
				method: "POST",
				payload: { message: "Not Found" },
				status: HTTP_NOT_FOUND,
				url: TOKENS_URL,
			}),
		]);
		const promise = fetchOrgMembership(await makeClient(), "octo", "someone");
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			endpoint: "POST /app/installations/{installation_id}/access_tokens",
			status: HTTP_NOT_FOUND,
		});
	});
});

describe("listPullRequestReviews()", () => {
	it("follows the link header until the last page", async () => {
		expect.hasAssertions();
		const firstUrl = reviewsUrl("?per_page=100");
		const secondUrl = reviewsUrl("?per_page=100&page=2");
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
			linkedRoute({ payload: [dismissed], url: reviewsUrl("?per_page=100") }),
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
				url: `${BASE}/repos/octo/hello/pulls/5`,
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

function reviewsPostUrl(repo: string = REPO.repo): string {
	return `${BASE}/repos/${REPO.owner}/${repo}/pulls/${PULL_NUMBER}/reviews`;
}
function reviewPostRoute(payload: unknown, status: number): PlannedRoute {
	return jsonRoute({ method: "POST", payload, status, url: reviewsPostUrl() });
}
/** The same POST against another repository, to exercise endpoint attribution. */
function reviewPostRouteOn(repo: string, status: number): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: { message: "boom" },
		status,
		url: reviewsPostUrl(repo),
	});
}

describe("createApprovalReview()", () => {
	it("returns created on 200 and posts commit_id with APPROVE", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([installTokenRoute(), reviewPostRoute({ id: 1 }, HTTP_OK)]);
		await expect(
			createApprovalReview(await makeClient(), REPO, PULL_NUMBER, "head-sha"),
		).resolves.toBe("created");
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
		await expect(
			createApprovalReview(await makeClient(), REPO, PULL_NUMBER, "head-sha"),
		).resolves.toBe("rejected");
	});

	it("throws GithubApiError on 500", async () => {
		expect.hasAssertions();
		installFetchMock([
			installTokenRoute(),
			reviewPostRoute({ message: "boom" }, HTTP_INTERNAL_ERROR),
		]);
		const promise = createApprovalReview(await makeClient(), REPO, PULL_NUMBER, "head-sha");
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			endpoint: "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			status: HTTP_INTERNAL_ERROR,
		});
	});

	it("does not attribute a repository named like the token path to token issuance", async () => {
		expect.hasAssertions();
		const repo = { owner: "octo", repo: "access_tokens" };
		installFetchMock([installTokenRoute(), reviewPostRouteOn(repo.repo, HTTP_INTERNAL_ERROR)]);
		const promise = createApprovalReview(await makeClient(), repo, PULL_NUMBER, "head-sha");
		await expect(promise).rejects.toMatchObject({
			endpoint: "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			status: HTTP_INTERNAL_ERROR,
		});
	});
});

/** The delivery signal on a recorded dispatch; absent means the budget did not reach it. */
function dispatchedSignal(seen: RecordedRequest): AbortSignal {
	const { signal } = seen;
	if (signal === undefined) {
		throw new Error(`no signal was installed on the dispatch: ${seen.url}`);
	}
	return signal;
}

describe("delivery deadline", () => {
	/* One budget for the delivery, not one per dispatch: a per-dispatch deadline could only fire
	 * first by being shorter than the whole delivery, which is the delivery budget again. The three
	 * dispatch kinds are all here — the auth strategy's token request, the call itself, and the
	 * pagination follow-up page, which carries no per-call request options. */
	it("puts the one delivery signal on the token request, the call, and each follow-up page", async () => {
		expect.hasAssertions();
		const firstUrl = commitsUrl("?per_page=100");
		const secondUrl = commitsUrl("?per_page=100&page=2");
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({ next: secondUrl, payload: commitPage(FULL_PAGE, 0), url: firstUrl }),
			linkedRoute({ payload: [commitBody("sha-tail")], url: secondUrl }),
		]);
		await listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		expect(mock.requests.map((seen) => seen.url)).toStrictEqual([TOKENS_URL, firstUrl, secondUrl]);
		const signals = mock.requests.map((seen) => dispatchedSignal(seen));
		expect(new Set(signals).size).toBe(1);
	});

	it("hands the dispatch a budget that has not expired yet", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute()]);
		await fetchAppBotLogin(await makeClient());
		expect(dispatchedSignal(requestByUrl(mock, APP_URL))).toMatchObject({ aborted: false });
	});
});
