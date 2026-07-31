/**
 * What every GitHub call goes through before it can succeed or fail, whichever endpoint it is
 * (src/client.ts): the App JWT and installation token the auth strategy issues, the API version the
 * before-request hook pins, and the one delivery budget every dispatch shares (SPEC.md §4). What a
 * call that fails becomes is asserted in test/api-error.test.ts.
 */

import {
	APP_URL,
	COMMITS_SUFFIX,
	JWT_PATTERN,
	NEXT_PAGE,
	REPO,
	TOKEN,
	TOKEN_URL,
	appRoute,
	commitItem,
	commitPage,
	installTokenRoute,
	linkedRoute,
	makeClient,
	pullUrl,
} from "./github-api";
import { PAGE_SIZE, fetchAppBotLogin, listPullRequestCommits } from "~src/github";
import { describe, expect, it } from "vitest";
import { installFetchMock, requestByUrl } from "./fetch-stub";
import { PULL_NUMBER } from "./fixtures";
import type { RecordedRequest } from "./fetch-stub";

describe("client authentication", () => {
	it(
		"authenticates the app endpoints with the app jwt and pins the api version",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const mock = installFetchMock([appRoute()]);
			await fetchAppBotLogin(await makeClient());
			const seen = requestByUrl(mock, APP_URL);
			expect(seen.headers["authorization"]).toMatch(JWT_PATTERN);
			expect(seen.headers["x-github-api-version"]).toBe("2022-11-28");
			expect(seen.headers["user-agent"]).toMatch(/^ghapprover /u);
		},
	);

	it("authenticates everything else with the installation token", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const firstUrl = pullUrl(COMMITS_SUFFIX);
		const mock = installFetchMock([
			installTokenRoute(),
			linkedRoute({ payload: [commitItem({ sha: "sha-a" })], url: firstUrl }),
		]);
		await listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
		expect(requestByUrl(mock, firstUrl).headers["authorization"]).toBe(`token ${TOKEN}`);
	});
});

/** The delivery signal on a recorded dispatch; absent means the budget did not reach it. */
function signalOf(seen: RecordedRequest): AbortSignal {
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
	it(
		"puts the one delivery signal on the token request, the call, and each follow-up page",
		{ timeout: 5000 },
		async () => {
			expect.hasAssertions();
			const firstUrl = pullUrl(COMMITS_SUFFIX);
			const secondUrl = pullUrl(`${COMMITS_SUFFIX}${NEXT_PAGE}`);
			const mock = installFetchMock([
				installTokenRoute(),
				linkedRoute({ next: secondUrl, payload: commitPage(PAGE_SIZE, 0), url: firstUrl }),
				linkedRoute({ payload: [commitItem({ sha: "sha-tail" })], url: secondUrl }),
			]);
			await listPullRequestCommits(await makeClient(), REPO, PULL_NUMBER);
			expect(mock.requests.map((seen) => seen.url)).toStrictEqual([TOKEN_URL, firstUrl, secondUrl]);
			const signals = mock.requests.map((seen) => signalOf(seen));
			expect(new Set(signals).size).toBe(1);
		},
	);

	it("hands the dispatch a budget that has not expired yet", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const mock = installFetchMock([appRoute()]);
		await fetchAppBotLogin(await makeClient());
		expect(signalOf(requestByUrl(mock, APP_URL))).toMatchObject({ aborted: false });
	});
});
