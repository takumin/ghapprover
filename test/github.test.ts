/* oxlint-disable max-lines -- exhaustive coverage of the eight-endpoint client in one deliverable file */
import {
	GithubApiError,
	createApprovalReview,
	createInstallationToken,
	fetchAppSlug,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "../src/github";
import { describe, expect, it } from "vitest";
import { installFetchMock, jsonRoute } from "./fetch-stub";

/** Derived from the harness so "./fetch-stub" stays a single import (no-duplicate-imports). */
type PlannedRoute = ReturnType<typeof jsonRoute>;

/** GitHub payloads model absent data as null (src/types.ts). */
// oxlint-disable-next-line unicorn/no-null -- single sanctioned null literal for the contract above
const NULL = null;

const BASE = "https://api.github.com";
const REPO = { owner: "octo", repo: "hello" };
const APP_JWT = "app-jwt";
const TOKEN = "installation-token";
const PULL_NUMBER = 5;
const INSTALLATION_ID = 12_345;
const FULL_PAGE = 100;
const SECOND_PAGE_COUNT = 37;
const ACCOUNT = { id: 7, login: "octo", type: "User" };

function commitBody(sha: string): Record<string, unknown> {
	return { author: ACCOUNT, commit: { verification: { verified: true } }, committer: ACCOUNT, sha };
}
function commitPage(count: number, offset: number): Record<string, unknown>[] {
	return Array.from({ length: count }, (_, index) => commitBody(`sha-${offset + index}`));
}
function reviewBody(commitId: string): Record<string, unknown> {
	return { commit_id: commitId, state: "APPROVED", user: ACCOUNT };
}
function reviewPage(count: number): Record<string, unknown>[] {
	return Array.from({ length: count }, (_, index) => reviewBody(`rev-${index}`));
}
function commitsUrl(page: string): string {
	return `${BASE}/repos/octo/hello/pulls/5/commits?per_page=100&page=${page}`;
}
function reviewsUrl(page: string): string {
	return `${BASE}/repos/octo/hello/pulls/5/reviews?per_page=100&page=${page}`;
}
function commitsRoute(page: string, payload: unknown): PlannedRoute {
	return jsonRoute({ method: "GET", payload, status: 200, url: commitsUrl(page) });
}
function reviewsRoute(page: string, payload: unknown): PlannedRoute {
	return jsonRoute({ method: "GET", payload, status: 200, url: reviewsUrl(page) });
}

describe("fetchAppSlug()", () => {
	it("returns the slug", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			jsonRoute({ method: "GET", payload: { slug: "my-app" }, status: 200, url: `${BASE}/app` }),
		]);
		await expect(fetchAppSlug(APP_JWT)).resolves.toBe("my-app");
		mock.assertDone();
	});

	it("throws GithubApiError when the slug is missing", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({ method: "GET", payload: { id: 1 }, status: 200, url: `${BASE}/app` }),
		]);
		const promise = fetchAppSlug(APP_JWT);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: "GET /app", status: 200 });
	});

	it("sends bearer auth and the required headers", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			jsonRoute({ method: "GET", payload: { slug: "my-app" }, status: 200, url: `${BASE}/app` }),
		]);
		await fetchAppSlug(APP_JWT);
		expect(mock.requests[0]).toMatchObject({
			headers: {
				accept: "application/vnd.github+json",
				authorization: "Bearer app-jwt",
				"user-agent": "ghapprover",
				"x-github-api-version": "2022-11-28",
			},
		});
	});

	it("wraps network failures with status 0", async () => {
		expect.hasAssertions();
		installFetchMock([jsonRoute({ method: "GET", payload: {}, status: 0, url: `${BASE}/app` })]);
		const promise = fetchAppSlug(APP_JWT);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: "GET /app", status: 0 });
	});
});

describe("createInstallationToken()", () => {
	const TOKENS_URL = `${BASE}/app/installations/12345/access_tokens`;

	it("returns the token on 201", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			jsonRoute({ method: "POST", payload: { token: TOKEN }, status: 201, url: TOKENS_URL }),
		]);
		await expect(createInstallationToken(APP_JWT, INSTALLATION_ID)).resolves.toBe(TOKEN);
		mock.assertDone();
	});

	it("throws when the token field is missing", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({ method: "POST", payload: { expires_at: "soon" }, status: 201, url: TOKENS_URL }),
		]);
		const promise = createInstallationToken(APP_JWT, INSTALLATION_ID);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
	});
});

describe("listPullRequestCommits() pagination", () => {
	it("paginates two pages with exact query strings", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			commitsRoute("1", commitPage(FULL_PAGE, 0)),
			commitsRoute("2", commitPage(SECOND_PAGE_COUNT, FULL_PAGE)),
		]);
		const commits = await listPullRequestCommits(TOKEN, REPO, PULL_NUMBER);
		expect(commits).toHaveLength(FULL_PAGE + SECOND_PAGE_COUNT);
		expect(commits.at(-1)).toMatchObject({ sha: "sha-136" });
		expect(mock.requests.map((seen) => seen.url)).toStrictEqual([commitsUrl("1"), commitsUrl("2")]);
	});

	it("caps pagination at three pages", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			commitsRoute("1", commitPage(FULL_PAGE, 0)),
			commitsRoute("2", commitPage(FULL_PAGE, FULL_PAGE)),
			commitsRoute("3", commitPage(FULL_PAGE, FULL_PAGE + FULL_PAGE)),
		]);
		const commits = await listPullRequestCommits(TOKEN, REPO, PULL_NUMBER);
		expect(commits).toHaveLength(FULL_PAGE + FULL_PAGE + FULL_PAGE);
		expect(mock.requests.map((seen) => seen.url)).toStrictEqual([
			commitsUrl("1"),
			commitsUrl("2"),
			commitsUrl("3"),
		]);
		mock.assertDone();
	});
});

describe("listPullRequestCommits() mapping", () => {
	it("maps fields and stops after a single short page", async () => {
		expect.hasAssertions();
		const webCommit = {
			author: NULL,
			commit: { extra: true, verification: { reason: "valid", verified: true } },
			committer: ACCOUNT,
			sha: "sha-web",
		};
		const mock = installFetchMock([commitsRoute("1", [commitBody("sha-a"), webCommit])]);
		const commits = await listPullRequestCommits(TOKEN, REPO, PULL_NUMBER);
		expect(commits).toStrictEqual([
			{
				author: ACCOUNT,
				commit: { verification: { verified: true } },
				committer: ACCOUNT,
				sha: "sha-a",
			},
			{
				author: NULL,
				commit: { verification: { verified: true } },
				committer: ACCOUNT,
				sha: "sha-web",
			},
		]);
		expect(mock.requests.map((seen) => seen.url)).toStrictEqual([commitsUrl("1")]);
	});

	it("throws GithubApiError on a malformed commit item", async () => {
		expect.hasAssertions();
		installFetchMock([commitsRoute("1", [{ commit: { verification: { verified: true } } }])]);
		const promise = listPullRequestCommits(TOKEN, REPO, PULL_NUMBER);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			endpoint: "GET /repos/octo/hello/pulls/5/commits",
			status: 200,
		});
	});
});

describe("fetchOrgMembership()", () => {
	const MEMBERSHIP_URL = `${BASE}/orgs/octo/memberships/someone`;

	it("maps an active admin membership", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			jsonRoute({
				method: "GET",
				payload: { organization_url: "ignored", role: "admin", state: "active" },
				status: 200,
				url: MEMBERSHIP_URL,
			}),
		]);
		await expect(fetchOrgMembership(TOKEN, "octo", "someone")).resolves.toStrictEqual({
			role: "admin",
			state: "active",
		});
		mock.assertDone();
	});

	it("returns null on 404", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({ method: "GET", payload: { message: "no" }, status: 404, url: MEMBERSHIP_URL }),
		]);
		await expect(fetchOrgMembership(TOKEN, "octo", "someone")).resolves.toBeNull();
	});

	it("throws with the status on 403", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({ method: "GET", payload: { message: "no" }, status: 403, url: MEMBERSHIP_URL }),
		]);
		const promise = fetchOrgMembership(TOKEN, "octo", "someone");
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ status: 403 });
	});
});

describe("listPullRequestReviews()", () => {
	it("paginates until a short page", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			reviewsRoute("1", reviewPage(FULL_PAGE)),
			reviewsRoute("2", [reviewBody("rev-tail")]),
		]);
		const reviews = await listPullRequestReviews(TOKEN, REPO, PULL_NUMBER);
		expect(reviews).toHaveLength(FULL_PAGE + 1);
		expect(mock.requests.map((seen) => seen.url)).toStrictEqual([reviewsUrl("1"), reviewsUrl("2")]);
	});

	it("maps null user and null commit_id", async () => {
		expect.hasAssertions();
		const dismissed = { commit_id: NULL, state: "DISMISSED", submitted_at: "ignored", user: NULL };
		const mock = installFetchMock([reviewsRoute("1", [dismissed])]);
		await expect(listPullRequestReviews(TOKEN, REPO, PULL_NUMBER)).resolves.toStrictEqual([
			{ commit_id: NULL, state: "DISMISSED", user: NULL },
		]);
		mock.assertDone();
	});
});

describe("fetchPullRequest()", () => {
	it("maps only the contract fields", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			jsonRoute({
				method: "GET",
				payload: { draft: false, head: { label: "octo:main", sha: "live-sha" }, state: "open" },
				status: 200,
				url: `${BASE}/repos/octo/hello/pulls/5`,
			}),
		]);
		await expect(fetchPullRequest(TOKEN, REPO, PULL_NUMBER)).resolves.toStrictEqual({
			draft: false,
			head: { sha: "live-sha" },
			state: "open",
		});
		mock.assertDone();
	});
});

describe("createApprovalReview()", () => {
	const REVIEWS_URL = `${BASE}/repos/octo/hello/pulls/5/reviews`;

	it("returns created on 200 and posts commit_id with APPROVE", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			jsonRoute({ method: "POST", payload: { id: 1 }, status: 200, url: REVIEWS_URL }),
		]);
		await expect(createApprovalReview(TOKEN, REPO, PULL_NUMBER, "head-sha")).resolves.toBe(
			"created",
		);
		expect(mock.requests[0]).toMatchObject({
			body: '{"commit_id":"head-sha","event":"APPROVE"}',
			headers: { "content-type": "application/json" },
		});
	});

	it("returns rejected on 422", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({ method: "POST", payload: { message: "closed" }, status: 422, url: REVIEWS_URL }),
		]);
		await expect(createApprovalReview(TOKEN, REPO, PULL_NUMBER, "head-sha")).resolves.toBe(
			"rejected",
		);
	});

	it("throws GithubApiError on 500", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({ method: "POST", payload: { message: "boom" }, status: 500, url: REVIEWS_URL }),
		]);
		const promise = createApprovalReview(TOKEN, REPO, PULL_NUMBER, "head-sha");
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			endpoint: "POST /repos/octo/hello/pulls/5/reviews",
			status: 500,
		});
	});
});
