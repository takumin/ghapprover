/**
 * One webhook delivery, end to end: the signed request the Worker is handed, the env it runs
 * against, and the planned fetch routes a full run consumes (SPEC.md §4). Shared by the suite that
 * drives the entry point (index.test.ts) and the ones that drive the pipeline behind it
 * (pipeline*.test.ts), so a delivery is built the same way in all of them — a route stated twice
 * is a route that can disagree with itself about what the pipeline actually calls.
 */

import { APP_BOT, ORG } from "./accounts";
import {
	APP_URL,
	BASE,
	HTTP_NOT_FOUND,
	HTTP_OK,
	PULL_NUMBER,
	jsonRoute,
	tokenRoute,
	tokenUrl,
} from "./fetch-stub";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import type { GithubAccount } from "../src/types";
import type { PlannedRoute } from "./fetch-stub";
import { expect } from "vitest";
import { privateKeyPemOnce } from "./app-key";
import { sign } from "@octokit/webhooks-methods";
import worker from "../src/index";

/** One byte past GitHub's 25 MB webhook payload cap. */
export const OVERSIZED_BODY_BYTES = 26_214_401;

export const WEBHOOK_URL = "http://example.com/webhook";
export const SECRET = "test-secret";
export const DELIVERY_ID = "delivery-42";
export const HEAD_SHA = "head-sha";
const INSTALLATION_ID = 67_890;
const INSTALL_TOKEN = "install-token";
const APP_SLUG = "ghapprover";
/** The repository every payload fixture is for; the routes below are the calls made against it. */
const REPO_NAME = "hello";
export const TOKEN_URL = tokenUrl(INSTALLATION_ID);
export const membershipUrl = (login: string): string =>
	`${BASE}/orgs/${ORG.login}/memberships/${login}`;
export const COMMITS_SUFFIX = "/commits?per_page=100";
const REVIEWS_SUFFIX = "/reviews?per_page=100";

const OWNER: GithubAccount = { id: 7, login: "octo", type: "User" };
export const STRANGER: GithubAccount = { id: 999, login: "mallory", type: "User" };
export const OTHER_STRANGER: GithubAccount = { id: 998, login: "eve", type: "User" };
export const OWN_APPROVAL = { commit_id: HEAD_SHA, state: "APPROVED", user: APP_BOT };

/** The env a delivery runs against; a case about the configuration itself overrides the one secret it is about. */
export async function makeEnv(overrides: Partial<Env> = {}): Promise<Env> {
	const env: Env = {
		GITHUB_APP_ID: "12345",
		GITHUB_APP_PRIVATE_KEY: await privateKeyPemOnce(),
		GITHUB_WEBHOOK_SECRET: SECRET,
	};
	return Object.assign(env, overrides);
}

/** The base repository id; the head repo defaults to the same one, so PRs are not forks. */
export const REPO_ID = 555;

interface PayloadOverrides {
	readonly action?: string;
	readonly commits?: number;
	readonly draft?: boolean;
	readonly headRepo?: { readonly id: number } | null;
	/** Deliberately untyped: the suites also build bodies the payload schema must refuse. */
	readonly headSha?: unknown;
	readonly installation?: { readonly id: number } | null;
	readonly repoOwner?: GithubAccount;
	readonly state?: string;
	readonly user?: GithubAccount;
}

export function buildPayload(overrides: PayloadOverrides = {}): string {
	const {
		action = "opened",
		commits = 1,
		draft = false,
		headRepo = { id: REPO_ID },
		headSha = HEAD_SHA,
		installation = { id: INSTALLATION_ID },
		repoOwner = OWNER,
		state = "open",
		user = OWNER,
	} = overrides;
	return JSON.stringify({
		action,
		installation,
		pull_request: {
			commits,
			draft,
			head: { repo: headRepo, sha: headSha },
			number: PULL_NUMBER,
			state,
			user,
		},
		repository: {
			full_name: `${repoOwner.login}/${REPO_NAME}`,
			id: REPO_ID,
			name: REPO_NAME,
			owner: repoOwner,
		},
	});
}

interface CommitOverrides {
	readonly author?: GithubAccount;
	readonly committer?: GithubAccount;
	readonly verified?: boolean;
}

export function commitItem(overrides: CommitOverrides = {}): Record<string, unknown> {
	const { author = OWNER, committer = OWNER, verified = true } = overrides;
	return { author, commit: { verification: { verified } }, committer, sha: HEAD_SHA };
}

export function pullsUrl(owner: string, suffix: string): string {
	return `${BASE}/repos/${owner}/${REPO_NAME}/pulls/${PULL_NUMBER}${suffix}`;
}

export function installTokenRoute(): PlannedRoute {
	return tokenRoute({ token: INSTALL_TOKEN, url: TOKEN_URL });
}
/** A 200 GET route; every route the pipeline reads apart from the membership lookups is one. */
function getRoute(url: string, payload: unknown): PlannedRoute {
	return jsonRoute({ method: "GET", payload, status: HTTP_OK, url });
}
export function appRoute(): PlannedRoute {
	return getRoute(APP_URL, { slug: APP_SLUG });
}
/** The two membership answers §3.1 turns on: an active admin, or the 404 that means "not a member". */
export function membershipAdminRoute(login: string): PlannedRoute {
	return jsonRoute({
		method: "GET",
		payload: { role: "admin", state: "active" },
		status: HTTP_OK,
		url: membershipUrl(login),
	});
}
export function membershipMissingRoute(login: string): PlannedRoute {
	return jsonRoute({
		method: "GET",
		payload: { message: "Not Found" },
		status: HTTP_NOT_FOUND,
		url: membershipUrl(login),
	});
}
export function commitsRouteFor(owner: string, commits: unknown): PlannedRoute {
	return getRoute(pullsUrl(owner, COMMITS_SUFFIX), commits);
}
export function reviewsRouteFor(owner: string, reviews: unknown): PlannedRoute {
	return getRoute(pullsUrl(owner, REVIEWS_SUFFIX), reviews);
}
function liveRouteFor(owner: string, sha: string): PlannedRoute {
	return getRoute(pullsUrl(owner, ""), { draft: false, head: { sha }, state: "open" });
}
export function reviewPostRouteFor(owner: string, status: number): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: { id: 1 },
		status,
		url: pullsUrl(owner, "/reviews"),
	});
}

interface PipelineRoutesOptions {
	readonly commits: readonly unknown[];
	readonly liveSha?: string;
	readonly owner: string;
	readonly reviews: readonly unknown[];
}

/** The GET routes every full pipeline run consumes after token issuance. */
export function pipelineRoutes(options: PipelineRoutesOptions): PlannedRoute[] {
	const { commits, liveSha = HEAD_SHA, owner, reviews } = options;
	return [
		commitsRouteFor(owner, commits),
		appRoute(),
		reviewsRouteFor(owner, reviews),
		liveRouteFor(owner, liveSha),
	];
}

export function happyRoutes(): PlannedRoute[] {
	return [
		installTokenRoute(),
		...pipelineRoutes({ commits: [commitItem()], owner: "octo", reviews: [] }),
		reviewPostRouteFor("octo", HTTP_OK),
	];
}

export async function dispatch(request: Request, env?: Env): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env ?? (await makeEnv()), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/** The three headers GitHub sends on every delivery; cases vary the signature and the event. */
export function deliveryHeaders(
	signature: string,
	eventName = "pull_request",
): Record<string, string> {
	return {
		"x-github-delivery": DELIVERY_ID,
		"x-github-event": eventName,
		"x-hub-signature-256": signature,
	};
}
/** For deliveries rejected before verification runs, so the digest is never reached. */
export const UNCHECKED_SIGNATURE = "sha256=00";
/* A streamed delivery body, which carries no Content-Length. duplex is required by the Fetch
 * spec for a stream body and is passed as an object literal because RequestInit omits it. */
export function streamedDelivery(body: ReadableStream<Uint8Array>, signature: string): Request {
	const init = { body, duplex: "half", headers: deliveryHeaders(signature), method: "POST" };
	return new Request(WEBHOOK_URL, init);
}

export async function postSigned(
	body: string,
	eventName = "pull_request",
	env?: Env,
): Promise<Response> {
	const request = new Request(WEBHOOK_URL, {
		body,
		headers: deliveryHeaders(await sign(SECRET, body), eventName),
		method: "POST",
	});
	return dispatch(request, env);
}

interface ExpectedReply {
	readonly body: Record<string, string>;
	readonly status: number;
}

export async function expectReply(response: Response, expected: ExpectedReply): Promise<void> {
	expect(response.status).toBe(expected.status);
	expect(response.headers.get("content-type")).toBe("application/json");
	const body: unknown = await response.json();
	expect(body).toStrictEqual(expected.body);
}
