/**
 * The planned fetch routes and the client factory the two GitHub-facing suites share:
 * github.test.ts drives the endpoints and their response mapping (src/github.ts), client.test.ts
 * drives what every call goes through (src/client.ts). Both need the same installation-token
 * route and the same page shapes, so a route stated once here cannot drift between them.
 */

import { HTTP_OK, jsonRoute, tokenRoute } from "./fetch-stub";
import type { GithubClient } from "../src/client";
import type { PlannedRoute } from "./fetch-stub";
import { createGithubClient } from "../src/client";
import { privateKeyPemOnce } from "./app-key";

export const BASE = "https://api.github.com";
export const REPO = { owner: "octo", repo: "hello" };
export const TOKEN = "installation-token";
export const PULL_NUMBER = 5;
const INSTALLATION_ID = 12_345;
export const TOKENS_URL = `${BASE}/app/installations/${INSTALLATION_ID}/access_tokens`;
export const APP_URL = `${BASE}/app`;
const MEMBERSHIP_URL = `${BASE}/orgs/octo/memberships/someone`;
export const FULL_PAGE = 100;
export const ACCOUNT = { id: 7, login: "octo", type: "User" };

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
export function commitsUrl(query: string): string {
	return `${BASE}/repos/octo/hello/pulls/5/commits${query}`;
}
export function reviewsUrl(query: string): string {
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

export function reviewsPostUrl(repo: string = REPO.repo): string {
	return `${BASE}/repos/${REPO.owner}/${repo}/pulls/${PULL_NUMBER}/reviews`;
}
export function reviewPostRoute(payload: unknown, status: number): PlannedRoute {
	return jsonRoute({ method: "POST", payload, status, url: reviewsPostUrl() });
}
