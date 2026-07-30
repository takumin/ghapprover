/**
 * What a failed GitHub call becomes (src/api-error.ts): the mapping of a thrown octokit failure
 * onto GithubApiError, the SPEC.md §8 diagnostics that error carries, and whose failure it was —
 * the auth strategy's internal token request surfaces as an exception from whichever call ran
 * first, so attribution is part of the contract rather than an inference the caller makes
 * (SPEC.md §9). Driven through the endpoints in src/github.ts, since that is where the mapping is
 * applied; what every call shares before it fails is asserted in test/client.test.ts.
 */

import {
	APP_ENDPOINT,
	APP_URL,
	REFUSAL_HEADERS,
	REPO,
	REVIEW_POST_ENDPOINT,
	TOKEN_ENDPOINT,
	TOKEN_URL,
	appRoute,
	approvalTarget,
	installTokenRoute,
	makeClient,
	pullUrl,
} from "./github-api";
import {
	HTTP_FORBIDDEN,
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	installFetchMock,
	jsonRoute,
} from "./fetch-stub";
import { HUMAN, ORG } from "./fixtures";
import { createApprovalReview, fetchAppBotLogin, fetchOrgMembership } from "../src/github";
import { describe, expect, it } from "vitest";
import { GithubApiError } from "../src/api-error";

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
			endpoint: APP_ENDPOINT,
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
			endpoint: APP_ENDPOINT,
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
			endpoint: APP_ENDPOINT,
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
			endpoint: APP_ENDPOINT,
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
				url: TOKEN_URL,
			}),
		]);
		const promise = fetchOrgMembership(await makeClient(), ORG.login, HUMAN.login);
		await expect(promise).rejects.toBeInstanceOf(GithubApiError);
		await expect(promise).rejects.toMatchObject({
			endpoint: TOKEN_ENDPOINT,
			status: HTTP_NOT_FOUND,
		});
	});

	it("does not attribute a repository named like the token path to token issuance", async () => {
		expect.hasAssertions();
		const repo = { owner: REPO.owner, repo: "access_tokens" };
		installFetchMock([
			installTokenRoute(),
			jsonRoute({
				method: "POST",
				payload: { message: "boom" },
				status: HTTP_INTERNAL_ERROR,
				url: pullUrl("/reviews", repo.owner, repo.repo),
			}),
		]);
		const promise = createApprovalReview(await makeClient(), approvalTarget(repo));
		await expect(promise).rejects.toMatchObject({
			endpoint: REVIEW_POST_ENDPOINT,
			status: HTTP_INTERNAL_ERROR,
		});
	});
});
