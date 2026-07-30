/**
 * The planned fetch routes and the client factory the two GitHub-facing suites share:
 * github.test.ts drives the endpoints and their response mapping (src/github.ts), client.test.ts
 * drives what every call goes through (src/client.ts). Both need the same installation-token
 * route and the same page shapes, so a route stated once here cannot drift between them.
 */

import { APP_URL, BASE, HTTP_OK, PULL_NUMBER, jsonRoute, tokenRoute, tokenUrl } from "./fetch-stub";
import type { ApprovalTarget, RepoRef } from "../src/github";
import type { GithubClient } from "../src/client";
import { OCTO } from "./accounts";
import type { PlannedRoute } from "./fetch-stub";
import { createGithubClient } from "../src/client";
import { privateKeyPemOnce } from "./app-key";

export const ACCOUNT = OCTO;
export const REPO: RepoRef = { owner: ACCOUNT.login, repo: "hello" };
export const TOKEN = "installation-token";
const INSTALLATION_ID = 12_345;
export const TOKENS_URL = tokenUrl(INSTALLATION_ID);
/* The org and member the membership cases look up, stated with the URL they are planned on rather
 * than beside it: the call itself is made with these, so a URL built from its own literals would
 * surface as an unplanned request instead of as an assertion about the wrong lookup. */
export const MEMBERSHIP_ORG = REPO.owner;
export const MEMBERSHIP_USER = "someone";
const MEMBERSHIP_URL = `${BASE}/orgs/${MEMBERSHIP_ORG}/memberships/${MEMBERSHIP_USER}`;
export const FULL_PAGE = 100;

export async function makeClient(): Promise<GithubClient> {
	return createGithubClient(
		{ appId: "12345", privateKeyPem: await privateKeyPemOnce() },
		INSTALLATION_ID,
	);
}

/** The lazily issued installation token consumed by installation-authed calls. */
export function installTokenRoute(): PlannedRoute {
	return tokenRoute({ token: TOKEN, url: TOKENS_URL });
}
const APP_BODY = { slug: "my-app" };
/** A 200 GET /app; the payload is overridden only where the test is about a malformed response. */
export function appRoute(payload: unknown = APP_BODY): PlannedRoute {
	return jsonRoute({ method: "GET", payload, status: HTTP_OK, url: APP_URL });
}

export function commitBody(sha: string): Record<string, unknown> {
	return { author: ACCOUNT, commit: { verification: { verified: true } }, committer: ACCOUNT, sha };
}
export function commitPage(count: number, offset: number): Record<string, unknown>[] {
	return Array.from({ length: count }, (_, index) => commitBody(`sha-${offset + index}`));
}
/* Every per-PR route the endpoint suites plan, built from the REPO and PULL_NUMBER the calls
 * themselves are made with: a URL assembled from its own literals can disagree with those, and
 * surfaces as the stub's "unplanned request" rather than as an assertion about the wrong route. */
export function pullUrl(suffix = "", repo: string = REPO.repo): string {
	return `${BASE}/repos/${REPO.owner}/${repo}/pulls/${PULL_NUMBER}${suffix}`;
}
export function commitsUrl(query: string): string {
	return pullUrl(`/commits${query}`);
}
export function reviewsUrl(query: string): string {
	return pullUrl(`/reviews${query}`);
}
/** The link header pagination follows; absent on the last page, which is how it stops. */
function linkHeaders(next: string | undefined): Record<string, string> | undefined {
	if (next === undefined) {
		return undefined;
	}
	return { link: `<${next}>; rel="next"` };
}
/** A page response whose link header points pagination at the next page, when there is one. */
export function linkedRoute(route: {
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

export function membershipRoute(payload: unknown, status: number): PlannedRoute {
	return jsonRoute({ method: "GET", payload, status, url: MEMBERSHIP_URL });
}

/** The review-POST URL; only the case about a repository named like the token path varies the repository. */
export function reviewsPostUrl(repo: string = REPO.repo): string {
	return pullUrl("/reviews", repo);
}
export function reviewPostRoute(payload: unknown, status: number): PlannedRoute {
	return jsonRoute({ method: "POST", payload, status, url: reviewsPostUrl() });
}
/** What every review-POST case approves; only the case about the URL varies the repository. */
export function approvalTarget(repo: RepoRef = REPO): ApprovalTarget {
	return { commitId: "head-sha", pullNumber: PULL_NUMBER, repo };
}
