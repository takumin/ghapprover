/**
 * The GitHub side of every suite's fixtures: the API origin and the route templates SPEC.md §8
 * names, the App installed on the fixture repository, that repository's pull request, and the
 * planned routes and response bodies its calls are served with. One module rather than one per suite
 * family, because the delivery suites and the endpoint suites call the same endpoints of the same
 * repository — a route built from its own literals can disagree with the call actually made, and
 * surfaces as the stub's "unplanned request" in whichever suite was not updated, which reads as a
 * routing bug rather than as a stale fixture. What one delivery does with these routes is in
 * test/delivery.ts; the stub that serves them is test/fetch-stub.ts. The App's own credentials —
 * its id and the private key every delivery is signed with — are part of that same App fixture, so
 * they are stated here together rather than in a module of their own that only ever travels with
 * this one.
 */

import { APP_SLUG, HEAD_SHA, ORG, OWNER, PULL_NUMBER, REPOSITORY } from "./fixtures";
import type { ApprovalTarget, RepoRef } from "~src/github";
import { HTTP_NOT_FOUND, HTTP_OK } from "~src/http-status";
import type { GithubAccount } from "~src/types";
import type { GithubClient } from "~src/client";
import { PAGE_SIZE } from "~src/github";
import type { PlannedRoute } from "./fetch-stub";
import { createGithubClient } from "~src/client";
import { jsonRoute } from "./fetch-stub";

/* The two statuses GitHub answers with that the Worker never names itself, so src/http-status.ts
 * does not state them: the 201 of a freshly issued installation token, and the 403 a refused call
 * comes back with. Stated with the routes they are planned on rather than with the stub that serves
 * them — a stub serves whatever status it is handed, and it is GitHub that decides these two. */
const HTTP_CREATED = 201;
const HTTP_FORBIDDEN = 403;

/** The API origin every route below is built on; the calls themselves reach nothing else. */
const BASE = "https://api.github.com";
/** App JWT authorization: "bearer" plus three dot-separated base64url segments. */
const JWT_PATTERN = /^bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/u;
/* The route templates SPEC.md §8's `endpoint` names, which is the vocabulary an operator greps: one
 * suite drives the call that raises them (github.test.ts, api-error.test.ts) and another the log
 * entry they end up in (pipeline-failures.test.ts), so a template stated per suite is one that can
 * be corrected in the one that fails and left wrong in the one that still passes. */
const APP_ENDPOINT = "GET /app";
const TOKEN_ENDPOINT = "POST /app/installations/{installation_id}/access_tokens";
const COMMITS_ENDPOINT = "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits";
const REVIEW_POST_ENDPOINT = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
/**
 * The headers GitHub sends on a refused call, which SPEC.md §8 logs alongside the status. Shared by
 * the suite that drives the mapping (api-error.test.ts) and the one that drives the log entry it
 * ends up in (pipeline-failures.test.ts): the §8 diagnostics set stated twice is a set that can be
 * extended in one suite and asserted in the other without either failing.
 */
const REFUSAL_HEADERS = {
	"x-accepted-github-permissions": "pull_requests=write",
	"x-github-request-id": "F1E2:3D4C",
	"x-ratelimit-remaining": "0",
	"x-ratelimit-reset": "1770000000",
};

/** The App every delivery is authed as: the id the env fixture declares and the App JWT's `iss`. */
const APP_ID = "12345";
/**
 * The App's private key: generated once per suite with real Web Crypto and exported as a PKCS#8
 * PEM, the only format the auth library can import (SPEC.md §7). PEM material is never hard-coded.
 */
const RSA_PARAMS = {
	hash: "SHA-256",
	modulusLength: 2048,
	name: "RSASSA-PKCS1-v1_5",
	publicExponent: new Uint8Array([1, 0, 1]),
};
const PEM_LINE_WIDTH = 64;

function wrapPem(base64: string): string {
	const lines: string[] = [];
	for (let offset = 0; offset < base64.length; offset += PEM_LINE_WIDTH) {
		lines.push(base64.slice(offset, offset + PEM_LINE_WIDTH));
	}
	return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

async function generatePrivateKeyPem(): Promise<string> {
	const generated = await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"]);
	if (!("privateKey" in generated)) {
		throw new Error("expected an RSA key pair");
	}
	const exported = await crypto.subtle.exportKey("pkcs8", generated.privateKey);
	if (!(exported instanceof ArrayBuffer)) {
		throw new Error("expected an ArrayBuffer export");
	}
	const chars = Array.from(new Uint8Array(exported), (byte) => String.fromCodePoint(byte));
	return wrapPem(btoa(chars.join("")));
}

let cachedPrivateKeyPem: Promise<string> | null = null;

/** Generates the PEM once and shares it across tests. */
async function privateKeyPemOnce(): Promise<string> {
	cachedPrivateKeyPem ??= generatePrivateKeyPem();
	const pem = await cachedPrivateKeyPem;
	return pem;
}
/** The installation the payload fixtures name, and whose token every non-app call is authed with. */
const INSTALLATION_ID = 67_890;
const TOKEN = "install-token";
/** GET /app takes no parameter, so its URL is the same one for every fixture repository and installation. */
const APP_URL = `${BASE}/app`;
/** The installation-token route, whose path the §8 attribution of a token failure is matched on. */
const TOKEN_URL = `${BASE}/app/installations/${INSTALLATION_ID}/access_tokens`;

async function makeClient(): Promise<GithubClient> {
	return createGithubClient(
		{ appId: APP_ID, privateKeyPem: await privateKeyPemOnce() },
		INSTALLATION_ID,
	);
}

function getJsonRoute(url: string, payload: unknown, status: number): PlannedRoute {
	return jsonRoute({ method: "GET", payload, status, url });
}
/** A 200 GET route; every route the pipeline reads apart from the membership lookups is one. */
function getRoute(url: string, payload: unknown): PlannedRoute {
	return getJsonRoute(url, payload, HTTP_OK);
}
/**
 * The installation token the auth strategy issues lazily inside whichever
 * installation-authed call runs first. The expiry is far enough out that the
 * strategy never treats the stub token as stale.
 */
function installTokenRoute(): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: { expires_at: "2126-01-01T00:00:00Z", token: TOKEN },
		status: HTTP_CREATED,
		url: TOKEN_URL,
	});
}
/** The slug GET /app answers with, which the App's own bot login is derived from (test/fixtures.ts). */
const APP_BODY = { slug: APP_SLUG };
/** GET /app; the payload is overridden only where the case is about a malformed response. */
function appRoute(payload: unknown = APP_BODY): PlannedRoute {
	return getRoute(APP_URL, payload);
}

/** The repository every fixture is for (test/fixtures.ts), as the GitHub API addresses it. */
const REPO: RepoRef = { owner: REPOSITORY.owner.login, repo: REPOSITORY.name };
/** The query the paginated routes are planned on, from the page size the calls themselves ask for. */
const COMMITS_SUFFIX = `/commits?per_page=${PAGE_SIZE}`;
const REVIEWS_SUFFIX = `/reviews?per_page=${PAGE_SIZE}`;
/** What the link header points the next page at, appended to the suffixes above. */
const NEXT_PAGE = "&page=2";
/* Every per-PR route is built from the repository and pull request the calls are themselves made
 * with: the owner varies where a case owns the repository through an organization, and the
 * repository name only for the one case about a repository named like the token path. */
function pullUrl(suffix = "", owner: string = REPO.owner, repo: string = REPO.repo): string {
	return `${BASE}/repos/${owner}/${repo}/pulls/${PULL_NUMBER}${suffix}`;
}
/** What every review-POST case approves; only the case about the URL varies the repository. */
function approvalTarget(repo: RepoRef = REPO): ApprovalTarget {
	return { commitId: HEAD_SHA, pullNumber: PULL_NUMBER, repo };
}

/* The four per-PR routes, each planned on the URL the matching call in src/github.ts is made on.
 * One builder apiece rather than one per suite family: the delivery suites consume these routes as
 * steps of a run and the endpoint suites plan them one call at a time, and a route built twice is
 * one that can be corrected in whichever suite failed and left wrong in the one that still passes.
 * The owner is the account owning the fixture repository, which varies only for the cases that own
 * it through an organization; what else a case varies is the response, which is why that is the
 * first parameter of the three routes whose body is read at all. */
function commitsRoute(payload: unknown, owner: GithubAccount = OWNER): PlannedRoute {
	return getRoute(pullUrl(COMMITS_SUFFIX, owner.login), payload);
}
function reviewsRoute(payload: unknown, owner: GithubAccount = OWNER): PlannedRoute {
	return getRoute(pullUrl(REVIEWS_SUFFIX, owner.login), payload);
}
/** The §3.3 live read, which a case varies only by the head it reports. */
function livePullRequestRoute(headSha: string, owner: GithubAccount = OWNER): PlannedRoute {
	return getRoute(pullUrl("", owner.login), {
		draft: false,
		head: { sha: headSha },
		state: "open",
	});
}
/** The review POST. Its response body is the one no caller reads, so a case varies only the status. */
function reviewPostRoute(status: number, owner: GithubAccount = OWNER): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: { id: 1 },
		status,
		url: pullUrl("/reviews", owner.login),
	});
}

/* The §3.1 membership lookup, for one account in the fixture organization: the URL, and the two
 * answers §3.1 turns on. Every route is planned for the account fixture the case names rather than
 * for a login repeated beside it — the two are one choice per case, and a URL built from its own
 * literals surfaces as the stub's "unplanned request" instead of as an assertion about the wrong
 * lookup. One set here rather than one per suite family: the endpoint suites and the delivery
 * suites look the same account up at the same URL. */
function membershipUrl(member: GithubAccount): string {
	return `${BASE}/orgs/${ORG.login}/memberships/${member.login}`;
}
function membershipRoute(member: GithubAccount, payload: unknown, status: number): PlannedRoute {
	return getJsonRoute(membershipUrl(member), payload, status);
}
function membershipAdminRoute(member: GithubAccount): PlannedRoute {
	return membershipRoute(member, { role: "admin", state: "active" }, HTTP_OK);
}
function membershipMissingRoute(member: GithubAccount): PlannedRoute {
	return membershipRoute(member, { message: "Not Found" }, HTTP_NOT_FOUND);
}

interface CommitOverrides {
	readonly author?: GithubAccount;
	readonly committer?: GithubAccount;
	readonly sha?: string;
	readonly verified?: boolean;
}
/** A commits-list item: verified and attributed to the repository owner unless the case says otherwise. */
function commitItem(overrides: CommitOverrides = {}): Record<string, unknown> {
	const { author = OWNER, committer = OWNER, sha = HEAD_SHA, verified = true } = overrides;
	return { author, commit: { verification: { verified } }, committer, sha };
}
/** A whole page of them, each under its own sha, for the pagination cases. */
function commitPage(count: number, offset: number): Record<string, unknown>[] {
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

export {
	APP_ENDPOINT,
	APP_ID,
	APP_URL,
	COMMITS_ENDPOINT,
	COMMITS_SUFFIX,
	HTTP_FORBIDDEN,
	INSTALLATION_ID,
	JWT_PATTERN,
	NEXT_PAGE,
	REFUSAL_HEADERS,
	REPO,
	REVIEWS_SUFFIX,
	REVIEW_POST_ENDPOINT,
	TOKEN,
	TOKEN_ENDPOINT,
	TOKEN_URL,
	appRoute,
	approvalTarget,
	commitItem,
	commitPage,
	commitsRoute,
	getRoute,
	installTokenRoute,
	linkedRoute,
	livePullRequestRoute,
	makeClient,
	membershipAdminRoute,
	membershipMissingRoute,
	membershipRoute,
	membershipUrl,
	privateKeyPemOnce,
	pullUrl,
	reviewPostRoute,
	reviewsRoute,
};
