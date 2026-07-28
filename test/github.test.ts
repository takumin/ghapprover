/* oxlint-disable max-lines -- exhaustive coverage of the six-endpoint client in one deliverable file */
import {
	GithubApiError,
	createApprovalReview,
	createBoundedFetch,
	createGithubClient,
	fetchAppSlug,
	fetchOrgMembership,
	fetchPullRequest,
	listPullRequestCommits,
	listPullRequestReviews,
} from "../src/github";
import { describe, expect, it } from "vitest";
import { installFetchMock, jsonRoute } from "./fetch-stub";
import { privateKeyPemOnce } from "./app-key";

/** Derived from the harness so "./fetch-stub" stays a single import (no-duplicate-imports). */
type PlannedRoute = ReturnType<typeof jsonRoute>;
type FetchMockSession = ReturnType<typeof installFetchMock>;
type RecordedRequest = FetchMockSession["requests"][number];
type GithubClient = ReturnType<typeof createGithubClient>;

/** GitHub payloads model absent data as null (src/types.ts). */
// oxlint-disable-next-line unicorn/no-null -- single sanctioned null literal for the contract above
const NULL = null;

const BASE = "https://api.github.com";
const REPO = { owner: "octo", repo: "hello" };
const TOKEN = "installation-token";
const PULL_NUMBER = 5;
const INSTALLATION_ID = 12_345;
const TOKENS_URL = `${BASE}/app/installations/${INSTALLATION_ID}/access_tokens`;
const FULL_PAGE = 100;
const SECOND_PAGE_COUNT = 37;
const ACCOUNT = { id: 7, login: "octo", type: "User" };
const HTTP_OK = 200;
const HTTP_CREATED = 201;
const HTTP_FORBIDDEN = 403;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_ERROR = 500;
/** App JWT authorization: "bearer" plus three dot-separated base64url segments. */
const JWT_PATTERN = /^bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/u;

async function makeClient(): Promise<GithubClient> {
	return createGithubClient(
		{ appId: "12345", privateKeyPem: await privateKeyPemOnce() },
		INSTALLATION_ID,
	);
}

function requestByUrl(session: FetchMockSession, url: string): RecordedRequest {
	const found = session.requests.find((entry) => entry.url === url);
	if (found === undefined) {
		throw new Error(`request not recorded: ${url}`);
	}
	return found;
}

/** The lazily issued installation token consumed by installation-authed calls. */
function tokenRoute(): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: { expires_at: "2126-01-01T00:00:00Z", token: TOKEN },
		status: HTTP_CREATED,
		url: TOKENS_URL,
	});
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
/** A page response whose link header points pagination at the next page. */
function linkedRoute(route: {
	readonly next?: string;
	readonly payload: unknown;
	readonly url: string;
}): PlannedRoute {
	if (route.next === undefined) {
		return jsonRoute({ method: "GET", payload: route.payload, status: HTTP_OK, url: route.url });
	}
	return jsonRoute({
		headers: { link: `<${route.next}>; rel="next"` },
		method: "GET",
		payload: route.payload,
		status: HTTP_OK,
		url: route.url,
	});
}

describe("fetchAppSlug()", () => {
	it("returns the slug without issuing an installation token", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			jsonRoute({
				method: "GET",
				payload: { slug: "my-app" },
				status: HTTP_OK,
				url: `${BASE}/app`,
			}),
		]);
		await expect(fetchAppSlug(await makeClient())).resolves.toBe("my-app");
		mock.assertDone();
	});

	it("authenticates with the app jwt and sends the pinned api version", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			jsonRoute({
				method: "GET",
				payload: { slug: "my-app" },
				status: HTTP_OK,
				url: `${BASE}/app`,
			}),
		]);
		await fetchAppSlug(await makeClient());
		const seen = requestByUrl(mock, `${BASE}/app`);
		expect(seen.headers["authorization"]).toMatch(JWT_PATTERN);
		expect(seen.headers["x-github-api-version"]).toBe("2022-11-28");
		expect(seen.headers["user-agent"]).toMatch(/^ghapprover /u);
	});

	it("throws GithubApiError when the slug is missing", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({ method: "GET", payload: { id: 1 }, status: HTTP_OK, url: `${BASE}/app` }),
		]);
		const promise = fetchAppSlug(await makeClient());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: "GET /app", status: HTTP_OK });
	});
});

describe("transport failure mapping", () => {
	it("wraps network failures with status 0", async () => {
		expect.hasAssertions();
		installFetchMock([jsonRoute({ method: "GET", payload: {}, status: 0, url: `${BASE}/app` })]);
		const promise = fetchAppSlug(await makeClient());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({ endpoint: "GET /app", status: 0 });
	});

	it("wraps an expired timeout signal with status 0", async () => {
		expect.hasAssertions();
		installFetchMock([
			{ body: "", method: "GET", rejectAs: "timeout", status: 0, url: `${BASE}/app` },
		]);
		const promise = fetchAppSlug(await makeClient());
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
			tokenRoute(),
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
			tokenRoute(),
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
			author: NULL,
			commit: { extra: true, verification: { reason: "valid", verified: true } },
			committer: ACCOUNT,
			sha: "sha-web",
		};
		const mock = installFetchMock([
			tokenRoute(),
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
				author: NULL,
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
			tokenRoute(),
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
			tokenRoute(),
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
		installFetchMock([tokenRoute(), membershipRoute({ message: "no" }, HTTP_NOT_FOUND)]);
		await expect(fetchOrgMembership(await makeClient(), "octo", "someone")).resolves.toBeNull();
	});

	it("throws with the status on 403", async () => {
		expect.hasAssertions();
		installFetchMock([tokenRoute(), membershipRoute({ message: "no" }, HTTP_FORBIDDEN)]);
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
			tokenRoute(),
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
		const dismissed = { commit_id: NULL, state: "DISMISSED", submitted_at: "ignored", user: NULL };
		const mock = installFetchMock([
			tokenRoute(),
			linkedRoute({ payload: [dismissed], url: reviewsUrl("?per_page=100") }),
		]);
		await expect(
			listPullRequestReviews(await makeClient(), REPO, PULL_NUMBER),
		).resolves.toStrictEqual([{ commit_id: NULL, state: "DISMISSED", user: NULL }]);
		mock.assertDone();
	});
});

describe("fetchPullRequest()", () => {
	it("maps only the contract fields", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([
			tokenRoute(),
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

const REVIEWS_POST_URL = `${BASE}/repos/octo/hello/pulls/5/reviews`;
function reviewPostRoute(payload: unknown, status: number): PlannedRoute {
	return jsonRoute({ method: "POST", payload, status, url: REVIEWS_POST_URL });
}
/** The same POST against another repository, to exercise endpoint attribution. */
function reviewPostRouteOn(repo: string, status: number): PlannedRoute {
	const url = `${BASE}/repos/octo/${repo}/pulls/${PULL_NUMBER}/reviews`;
	return jsonRoute({ method: "POST", payload: { message: "boom" }, status, url });
}

describe("createApprovalReview()", () => {
	it("returns created on 200 and posts commit_id with APPROVE", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([tokenRoute(), reviewPostRoute({ id: 1 }, HTTP_OK)]);
		await expect(
			createApprovalReview(await makeClient(), REPO, PULL_NUMBER, "head-sha"),
		).resolves.toBe("created");
		const posted = requestByUrl(mock, REVIEWS_POST_URL);
		expect(posted).toMatchObject({ body: '{"commit_id":"head-sha","event":"APPROVE"}' });
		expect(posted.headers["content-type"]).toMatch(/application\/json/u);
	});

	it("returns rejected on 422", async () => {
		expect.hasAssertions();
		installFetchMock([
			tokenRoute(),
			reviewPostRoute({ message: "closed" }, HTTP_UNPROCESSABLE_ENTITY),
		]);
		await expect(
			createApprovalReview(await makeClient(), REPO, PULL_NUMBER, "head-sha"),
		).resolves.toBe("rejected");
	});

	it("throws GithubApiError on 500", async () => {
		expect.hasAssertions();
		installFetchMock([tokenRoute(), reviewPostRoute({ message: "boom" }, HTTP_INTERNAL_ERROR)]);
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
		installFetchMock([tokenRoute(), reviewPostRouteOn(repo.repo, HTTP_INTERNAL_ERROR)]);
		const promise = createApprovalReview(await makeClient(), repo, PULL_NUMBER, "head-sha");
		await expect(promise).rejects.toMatchObject({
			endpoint: "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
			status: HTTP_INTERNAL_ERROR,
		});
	});
});

const APP_URL = `${BASE}/app`;
const RATE_LIMIT_URL = `${BASE}/rate_limit`;

/** The delivery signal the bounded fetch installs; absent means the wrapper did not run. */
function dispatchedSignal(init: RequestInit): AbortSignal {
	const { signal } = init;
	if (signal === undefined || signal === NULL) {
		throw new Error("no signal was installed on the dispatch");
	}
	return signal;
}

describe("delivery deadline", () => {
	it("hands a spent delivery budget to the dispatch as an already-aborted signal", async () => {
		expect.hasAssertions();
		installFetchMock([jsonRoute({ method: "GET", payload: {}, status: HTTP_OK, url: APP_URL })]);
		const delivery = new AbortController();
		const bounded = createBoundedFetch(delivery.signal);
		delivery.abort();
		const init: RequestInit = { method: "GET" };
		await bounded(APP_URL, init);
		expect(dispatchedSignal(init)).toMatchObject({ aborted: true });
	});

	/* One budget, not one per dispatch: a per-dispatch deadline could only fire first by
	 * being shorter than the whole delivery, which is the delivery budget again. */
	it("installs the one delivery signal on every dispatch", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({ method: "GET", payload: {}, status: HTTP_OK, url: APP_URL }),
			jsonRoute({ method: "GET", payload: {}, status: HTTP_OK, url: RATE_LIMIT_URL }),
		]);
		const delivery = new AbortController();
		const bounded = createBoundedFetch(delivery.signal);
		const first: RequestInit = { method: "GET" };
		const second: RequestInit = { method: "GET" };
		await expect(bounded(APP_URL, first)).resolves.toBeInstanceOf(Response);
		await expect(bounded(RATE_LIMIT_URL, second)).resolves.toBeInstanceOf(Response);
		expect(dispatchedSignal(first)).toBe(delivery.signal);
		expect(dispatchedSignal(second)).toBe(delivery.signal);
	});

	it("aborts an in-flight dispatch when the delivery budget expires mid-call", async () => {
		expect.hasAssertions();
		installFetchMock([jsonRoute({ method: "GET", payload: {}, status: HTTP_OK, url: APP_URL })]);
		const delivery = new AbortController();
		const bounded = createBoundedFetch(delivery.signal);
		const init: RequestInit = { method: "GET" };
		await bounded(APP_URL, init);
		delivery.abort();
		expect(dispatchedSignal(init)).toMatchObject({ aborted: true });
	});
});
