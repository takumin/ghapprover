/**
 * The GitHub side of every suite's fixtures: the API origin and the route templates SPEC.md §8
 * names, the App installed on the fixture repository, that repository's pull request, and the
 * planned routes and response bodies its calls are served with. One module rather than one per suite
 * family, because the delivery suites and the endpoint suites call the same endpoints of the same
 * repository — a route built from its own literals can disagree with the call actually made, and
 * surfaces as the stub's "unplanned request" in whichever suite was not updated, which reads as a
 * routing bug rather than as a stale fixture. What one delivery does with these routes is in
 * test/delivery.ts; the stub that serves them is test/fetch-stub.ts.
 */

import { APP_SLUG, HUMAN, ORG, OWNER } from "./accounts";
import type { ApprovalTarget, RepoRef } from "../src/github";
import { HTTP_CREATED, HTTP_OK, jsonRoute } from "./fetch-stub";
import type { GithubAccount } from "../src/types";
import type { GithubClient } from "../src/client";
import type { PlannedRoute } from "./fetch-stub";
import { createGithubClient } from "../src/client";
import { privateKeyPemOnce } from "./app-key";

export const BASE = "https://api.github.com";
/** App JWT authorization: "bearer" plus three dot-separated base64url segments. */
export const JWT_PATTERN = /^bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/u;
/* The route templates SPEC.md §8's `endpoint` names, which is the vocabulary an operator greps: one
 * suite drives the call that raises them (github.test.ts, api-error.test.ts) and another the log
 * entry they end up in (pipeline-failures.test.ts), so a template stated per suite is one that can
 * be corrected in the one that fails and left wrong in the one that still passes. */
export const APP_ENDPOINT = "GET /app";
export const TOKEN_ENDPOINT = "POST /app/installations/{installation_id}/access_tokens";
export const COMMITS_ENDPOINT = "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits";
export const REVIEW_POST_ENDPOINT = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
/**
 * The headers GitHub sends on a refused call, which SPEC.md §8 logs alongside the status. Shared by
 * the suite that drives the mapping (api-error.test.ts) and the one that drives the log entry it
 * ends up in (pipeline-failures.test.ts): the §8 diagnostics set stated twice is a set that can be
 * extended in one suite and asserted in the other without either failing.
 */
export const REFUSAL_HEADERS = {
	"x-accepted-github-permissions": "pull_requests=write",
	"x-github-request-id": "F1E2:3D4C",
	"x-ratelimit-remaining": "0",
	"x-ratelimit-reset": "1770000000",
};

/** The App every delivery is authed as: the id the env fixture declares and the App JWT's `iss`. */
export const APP_ID = "12345";
/** The installation the payload fixtures name, and whose token every non-app call is authed with. */
export const INSTALLATION_ID = 67_890;
export const TOKEN = "install-token";
/** GET /app takes no parameter, so its URL is the same one for every fixture repository and installation. */
export const APP_URL = `${BASE}/app`;
/** The installation-token route, whose path the §8 attribution of a token failure is matched on. */
export const TOKEN_URL = `${BASE}/app/installations/${INSTALLATION_ID}/access_tokens`;

export async function makeClient(): Promise<GithubClient> {
	return createGithubClient(
		{ appId: APP_ID, privateKeyPem: await privateKeyPemOnce() },
		INSTALLATION_ID,
	);
}

function getJsonRoute(url: string, payload: unknown, status: number): PlannedRoute {
	return jsonRoute({ method: "GET", payload, status, url });
}
/** A 200 GET route; every route the pipeline reads apart from the membership lookups is one. */
export function getRoute(url: string, payload: unknown): PlannedRoute {
	return getJsonRoute(url, payload, HTTP_OK);
}
/**
 * The installation token the auth strategy issues lazily inside whichever
 * installation-authed call runs first. The expiry is far enough out that the
 * strategy never treats the stub token as stale.
 */
export function installTokenRoute(): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: { expires_at: "2126-01-01T00:00:00Z", token: TOKEN },
		status: HTTP_CREATED,
		url: TOKEN_URL,
	});
}
/** The slug GET /app answers with, which the App's own bot login is derived from (test/accounts.ts). */
const APP_BODY = { slug: APP_SLUG };
/** GET /app; the payload is overridden only where the case is about a malformed response. */
export function appRoute(payload: unknown = APP_BODY): PlannedRoute {
	return getRoute(APP_URL, payload);
}

/** The repository every fixture is for, as the GitHub API addresses it. */
export const REPO_NAME = "hello";
export const REPO: RepoRef = { owner: OWNER.login, repo: REPO_NAME };
/** The pull request every payload fixture describes and every per-PR route below serves. */
export const PULL_NUMBER = 5;
export const HEAD_SHA = "head-sha";
/** The page size the list calls ask for, and therefore the query their routes are planned on. */
export const FULL_PAGE = 100;
export const COMMITS_SUFFIX = `/commits?per_page=${FULL_PAGE}`;
export const REVIEWS_SUFFIX = `/reviews?per_page=${FULL_PAGE}`;
/** What the link header points the next page at, appended to the suffixes above. */
export const NEXT_PAGE = "&page=2";
/* Every per-PR route is built from the repository and pull request the calls are themselves made
 * with: the owner varies where a case owns the repository through an organization, and the
 * repository name only for the one case about a repository named like the token path. */
export function pullUrl(suffix = "", owner: string = REPO.owner, repo: string = REPO.repo): string {
	return `${BASE}/repos/${owner}/${repo}/pulls/${PULL_NUMBER}${suffix}`;
}
/** What every review-POST case approves; only the case about the URL varies the repository. */
export function approvalTarget(repo: RepoRef = REPO): ApprovalTarget {
	return { commitId: HEAD_SHA, pullNumber: PULL_NUMBER, repo };
}

/* The org and member the endpoint suites look up, stated with the URL they are planned on rather
 * than beside it: the call itself is made with these, so a URL built from its own literals would
 * surface as an unplanned request instead of as an assertion about the wrong lookup. */
export const MEMBERSHIP_ORG = ORG.login;
export const MEMBERSHIP_USER = HUMAN.login;
export function membershipUrl(org: string, username: string): string {
	return `${BASE}/orgs/${org}/memberships/${username}`;
}
export function membershipRoute(payload: unknown, status: number): PlannedRoute {
	return getJsonRoute(membershipUrl(MEMBERSHIP_ORG, MEMBERSHIP_USER), payload, status);
}

interface CommitOverrides {
	readonly author?: GithubAccount;
	readonly committer?: GithubAccount;
	readonly sha?: string;
	readonly verified?: boolean;
}
/** A commits-list item: verified and attributed to the repository owner unless the case says otherwise. */
export function commitItem(overrides: CommitOverrides = {}): Record<string, unknown> {
	const { author = OWNER, committer = OWNER, sha = HEAD_SHA, verified = true } = overrides;
	return { author, commit: { verification: { verified } }, committer, sha };
}
/** A whole page of them, each under its own sha, for the pagination cases. */
export function commitPage(count: number, offset: number): Record<string, unknown>[] {
	return Array.from({ length: count }, (_, index) => commitItem({ sha: `sha-${offset + index}` }));
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
