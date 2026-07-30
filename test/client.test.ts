/**
 * What every GitHub call goes through before it can succeed or fail, whichever endpoint it is
 * (src/client.ts): the App JWT and installation token the auth strategy issues, the API version the
 * before-request hook pins, and the one delivery budget every dispatch shares (SPEC.md §4). What a
 * call that fails becomes is asserted in test/api-error.test.ts.
 */

import { APP_URL, JWT_PATTERN, PULL_NUMBER, installFetchMock, requestByUrl } from "./fetch-stub";
import {
	FULL_PAGE,
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
} from "./github-routes";
import { describe, expect, it } from "vitest";
import { fetchAppBotLogin, listPullRequestCommits } from "../src/github";
import type { RecordedRequest } from "./fetch-stub";

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
