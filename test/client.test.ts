/**
 * What every GitHub call goes through, whichever endpoint it is (src/client.ts): the App JWT and
 * installation token the auth strategy issues, the API version the before-request hook pins, the
 * one delivery budget every dispatch shares (SPEC.md §4), and the mapping of a thrown failure onto
 * GithubApiError — including whose failure it was, since the auth strategy's internal token
 * request surfaces as an exception from whichever call ran first (SPEC.md §9).
 */

import {
	APP_URL,
	FULL_PAGE,
	PULL_NUMBER,
	REPO,
	TOKEN,
	TOKENS_URL,
	appRoute,
	commitBody,
	commitPage,
	commitsUrl,
	installTokenRoute,
	linkedRoute,
	makeClient,
	reviewsPostUrl,
} from "./github-routes";
import {
	HTTP_FORBIDDEN,
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	JWT_PATTERN,
	REFUSAL_HEADERS,
	installFetchMock,
	jsonRoute,
	requestByUrl,
} from "./fetch-stub";
import {
	createApprovalReview,
	fetchAppBotLogin,
	fetchOrgMembership,
	listPullRequestCommits,
} from "../src/github";
import { describe, expect, it } from "vitest";
import { GithubApiError } from "../src/client";
import type { RecordedRequest } from "./fetch-stub";

const TOKEN_ENDPOINT = "POST /app/installations/{installation_id}/access_tokens";

describe("client authentication", () => {
	it("authenticates the app endpoints with the app jwt and pins the api version", async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute()]);
		await fetchAppBotLogin(await makeClient());
		const seen = requestByUrl(mock, APP_URL);
		expect(seen.headers["authorization"]).toMatch(JWT_PATTERN);
		expect(seen.headers["x-github-api-version"]).toBe("2022-11-28");
		expect(seen.headers["user-agent"]).toMatch(/^ghapprover /u);
	});

	it("authenticates everything else with the installation token", async () => {
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

/* A failure with no response has no §8 headers to report, so its own message is the whole of what
 * it can say about itself — which is why both cases below assert it (SPEC.md §8). */
describe("transport failure mapping", () => {
	it("wraps network failures with status 0", async () => {
		expect.hasAssertions();
		installFetchMock([jsonRoute({ method: "GET", payload: {}, status: 0, url: APP_URL })]);
		const promise = fetchAppBotLogin(await makeClient());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			diagnostics: { errorMessage: "simulated network failure", requestId: undefined },
			endpoint: "GET /app",
			status: 0,
		});
	});

	it("wraps an expired timeout signal with status 0", async () => {
		expect.hasAssertions();
		installFetchMock([{ body: "", method: "GET", rejectAs: "timeout", status: 0, url: APP_URL }]);
		const promise = fetchAppBotLogin(await makeClient());
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			diagnostics: { errorMessage: "The operation timed out.", requestId: undefined },
			endpoint: "GET /app",
			status: 0,
		});
	});
});

/* SPEC.md §8: what turns a grep hit on github-api-error into a cause. The status alone does not
 * say whether a 403 was a missing permission or a rate limit, and the fixed message this Worker
 * builds says nothing the endpoint and status do not — so both the response headers and the
 * originating message are carried on the error rather than dropped at the mapping. */
describe("failure diagnostics", () => {
	it("carries the response headers and the originating message of a refused call", async () => {
		expect.hasAssertions();
		installFetchMock([
			jsonRoute({
				headers: REFUSAL_HEADERS,
				method: "GET",
				payload: { message: "API rate limit exceeded" },
				status: HTTP_FORBIDDEN,
				url: APP_URL,
			}),
		]);
		const promise = fetchAppBotLogin(await makeClient());
		await expect(promise).rejects.toMatchObject({
			diagnostics: {
				acceptedPermissions: "pull_requests=write",
				errorMessage: "API rate limit exceeded",
				rateLimitRemaining: "0",
				rateLimitReset: "1770000000",
				requestId: "F1E2:3D4C",
			},
			endpoint: "GET /app",
			status: HTTP_FORBIDDEN,
		});
	});

	/* A 200 whose body does not match the contract is this Worker's own verdict, not GitHub's: no
	 * originating error to quote, and a response that was never a failure to read headers off. */
	it("carries nothing for a failure the worker raises itself", async () => {
		expect.hasAssertions();
		installFetchMock([appRoute({})]);
		const promise = fetchAppBotLogin(await makeClient());
		await expect(promise).rejects.toMatchObject({
			diagnostics: { errorMessage: undefined, requestId: undefined },
			endpoint: "GET /app",
		});
	});
});

describe("token request attribution", () => {
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
			endpoint: TOKEN_ENDPOINT,
			status: HTTP_NOT_FOUND,
		});
	});

	it("does not attribute a repository named like the token path to token issuance", async () => {
		expect.hasAssertions();
		const repo = { owner: "octo", repo: "access_tokens" };
		installFetchMock([
			installTokenRoute(),
			jsonRoute({
				method: "POST",
				payload: { message: "boom" },
				status: HTTP_INTERNAL_ERROR,
				url: reviewsPostUrl(repo.repo),
			}),
		]);
		const promise = createApprovalReview(await makeClient(), {
			commitId: "head-sha",
			pullNumber: PULL_NUMBER,
			repo,
		});
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
