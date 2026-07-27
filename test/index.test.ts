/* GitHub payloads model absence as null (src/types.ts), so the fixtures below
 * need null literals. The suite drives the whole SPEC.md §4 pipeline through
 * the stubbed fetch for every §8/§9 outcome, which does not fit the default
 * file length budget. */
/* oxlint-disable unicorn/no-null */
/* oxlint-disable max-lines */

import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { installFetchMock, jsonRoute } from "./fetch-stub";
import type { GithubAccount } from "../src/types";
import { MAX_VERIFIABLE_COMMITS } from "../src/allowlist";
import worker from "../src/index";

/** Derived from the harness so "./fetch-stub" stays a single import (no-duplicate-imports). */
type FetchMockSession = ReturnType<typeof installFetchMock>;
type PlannedRoute = ReturnType<typeof jsonRoute>;
type RecordedRequest = FetchMockSession["requests"][number];

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_ERROR = 500;

const WEBHOOK_URL = "http://example.com/webhook";
const SECRET = "test-secret";
const DELIVERY_ID = "delivery-42";
const HEAD_SHA = "head-sha";
const PULL_NUMBER = 5;
const INSTALLATION_ID = 67_890;
const INSTALL_TOKEN = "install-token";
const APP_SLUG = "ghapprover";
const BASE = "https://api.github.com";
const TOKEN_URL = `${BASE}/app/installations/${INSTALLATION_ID}/access_tokens`;
const APP_URL = `${BASE}/app`;
const MEMBERSHIP_URL = `${BASE}/orgs/acme/memberships/octo`;
const COMMITS_SUFFIX = "/commits?per_page=100&page=1";
const REVIEWS_SUFFIX = "/reviews?per_page=100&page=1";
/** App JWT shape: "Bearer" plus three dot-separated base64url segments. */
const JWT_PATTERN = /^Bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/u;

const OWNER: GithubAccount = { id: 7, login: "octo", type: "User" };
const ORG: GithubAccount = { id: 88, login: "acme", type: "Organization" };
const RENOVATE: GithubAccount = { id: 29_139_614, login: "renovate[bot]", type: "Bot" };
const WEB_FLOW: GithubAccount = { id: 19_864_447, login: "web-flow", type: "User" };
const STRANGER: GithubAccount = { id: 999, login: "mallory", type: "User" };
const APP_BOT_USER: GithubAccount = { id: 201, login: "ghapprover[bot]", type: "Bot" };
const OWN_APPROVAL = { commit_id: HEAD_SHA, state: "APPROVED", user: APP_BOT_USER };

const RSA_PARAMS = {
	hash: "SHA-256",
	modulusLength: 2048,
	name: "RSASSA-PKCS1-v1_5",
	publicExponent: new Uint8Array([1, 0, 1]),
};
const PEM_LINE_WIDTH = 64;
const HEX_RADIX = 16;
const HEX_PAD = 2;

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

/** Generated once and shared across tests; PEM material is never hard-coded. */
const KEY_CACHE = new Map<string, Promise<string>>();
async function privateKeyPemOnce(): Promise<string> {
	const cached = KEY_CACHE.get("pem");
	if (cached !== undefined) {
		return cached;
	}
	const generated = generatePrivateKeyPem();
	KEY_CACHE.set("pem", generated);
	return generated;
}

async function makeEnv(): Promise<Env> {
	return {
		GITHUB_APP_ID: "12345",
		GITHUB_APP_PRIVATE_KEY: await privateKeyPemOnce(),
		GITHUB_WEBHOOK_SECRET: SECRET,
	};
}

async function signBody(secret: string, body: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	const hex = Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(HEX_RADIX).padStart(HEX_PAD, "0"),
	).join("");
	return `sha256=${hex}`;
}

interface PayloadOverrides {
	readonly action?: string;
	readonly commits?: number;
	readonly draft?: boolean;
	readonly headRepo?: { readonly id: number } | null;
	readonly installation?: { readonly id: number } | null;
	readonly repoOwner?: GithubAccount;
	readonly state?: string;
	readonly user?: GithubAccount;
}

function buildPayload(overrides: PayloadOverrides = {}): string {
	const {
		action = "opened",
		commits = 1,
		draft = false,
		headRepo = { id: 555 },
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
			head: { repo: headRepo, sha: HEAD_SHA },
			number: PULL_NUMBER,
			state,
			user,
		},
		repository: { full_name: `${repoOwner.login}/hello`, name: "hello", owner: repoOwner },
	});
}

interface CommitOverrides {
	readonly author?: GithubAccount;
	readonly committer?: GithubAccount;
	readonly verified?: boolean;
}

function commitItem(overrides: CommitOverrides = {}): Record<string, unknown> {
	const { author = OWNER, committer = OWNER, verified = true } = overrides;
	return { author, commit: { verification: { verified } }, committer, sha: HEAD_SHA };
}

function pullsUrl(owner: string, suffix: string): string {
	return `${BASE}/repos/${owner}/hello/pulls/${PULL_NUMBER}${suffix}`;
}

function tokenRoute(): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: { token: INSTALL_TOKEN },
		status: 201,
		url: TOKEN_URL,
	});
}
function appRoute(): PlannedRoute {
	return jsonRoute({ method: "GET", payload: { slug: APP_SLUG }, status: 200, url: APP_URL });
}
function membershipRoute(route: {
	readonly payload: unknown;
	readonly status: number;
}): PlannedRoute {
	return jsonRoute({
		method: "GET",
		payload: route.payload,
		status: route.status,
		url: MEMBERSHIP_URL,
	});
}
function commitsRouteFor(owner: string, commits: unknown): PlannedRoute {
	return jsonRoute({
		method: "GET",
		payload: commits,
		status: 200,
		url: pullsUrl(owner, COMMITS_SUFFIX),
	});
}
function reviewsRouteFor(owner: string, reviews: unknown): PlannedRoute {
	return jsonRoute({
		method: "GET",
		payload: reviews,
		status: 200,
		url: pullsUrl(owner, REVIEWS_SUFFIX),
	});
}
function liveRouteFor(owner: string, sha: string): PlannedRoute {
	return jsonRoute({
		method: "GET",
		payload: { draft: false, head: { sha }, state: "open" },
		status: 200,
		url: pullsUrl(owner, ""),
	});
}
function reviewPostRoute(owner: string, status: number): PlannedRoute {
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
function pipelineRoutes(options: PipelineRoutesOptions): PlannedRoute[] {
	const { commits, liveSha = HEAD_SHA, owner, reviews } = options;
	return [
		commitsRouteFor(owner, commits),
		appRoute(),
		reviewsRouteFor(owner, reviews),
		liveRouteFor(owner, liveSha),
	];
}

function happyRoutes(): PlannedRoute[] {
	return [
		tokenRoute(),
		...pipelineRoutes({ commits: [commitItem()], owner: "octo", reviews: [] }),
		reviewPostRoute("octo", HTTP_OK),
	];
}

async function dispatch(request: Request): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, await makeEnv(), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function postSigned(body: string, eventName = "pull_request"): Promise<Response> {
	const request = new Request(WEBHOOK_URL, {
		body,
		headers: {
			"x-github-delivery": DELIVERY_ID,
			"x-github-event": eventName,
			"x-hub-signature-256": await signBody(SECRET, body),
		},
		method: "POST",
	});
	return dispatch(request);
}

interface ExpectedReply {
	readonly body: Record<string, string>;
	readonly status: number;
}

async function expectReply(response: Response, expected: ExpectedReply): Promise<void> {
	expect(response.status).toBe(expected.status);
	expect(response.headers.get("content-type")).toBe("application/json");
	const body: unknown = await response.json();
	expect(body).toStrictEqual(expected.body);
}

function requestByUrl(session: FetchMockSession, url: string): RecordedRequest {
	const found = session.requests.find((entry) => entry.url === url);
	if (found === undefined) {
		throw new Error(`request not recorded: ${url}`);
	}
	return found;
}

describe("request routing", () => {
	it("returns 404 for GET on the webhook path", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await dispatch(new Request(WEBHOOK_URL, { method: "GET" }));
		await expectReply(response, {
			body: { decision: "error", reason: "not-found" },
			status: HTTP_NOT_FOUND,
		});
	});

	it("returns 404 for POST outside the webhook path", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const request = new Request("http://example.com/other", { body: "{}", method: "POST" });
		await expectReply(await dispatch(request), {
			body: { decision: "error", reason: "not-found" },
			status: HTTP_NOT_FOUND,
		});
	});
});

describe("signature verification", () => {
	it("rejects a request without a signature header", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const request = new Request(WEBHOOK_URL, {
			body: buildPayload(),
			headers: { "x-github-delivery": DELIVERY_ID, "x-github-event": "pull_request" },
			method: "POST",
		});
		await expectReply(await dispatch(request), {
			body: { decision: "error", reason: "invalid-signature" },
			status: HTTP_UNAUTHORIZED,
		});
	});

	it("rejects a signature over a tampered body", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const signature = await signBody(SECRET, buildPayload());
		const request = new Request(WEBHOOK_URL, {
			body: buildPayload({ action: "synchronize" }),
			headers: {
				"x-github-delivery": DELIVERY_ID,
				"x-github-event": "pull_request",
				"x-hub-signature-256": signature,
			},
			method: "POST",
		});
		await expectReply(await dispatch(request), {
			body: { decision: "error", reason: "invalid-signature" },
			status: HTTP_UNAUTHORIZED,
		});
	});
});

describe("event scoping", () => {
	it("skips a ping event without parsing the body", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned("zen text, deliberately not JSON", "ping");
		await expectReply(response, {
			body: { decision: "skipped", reason: "event-out-of-scope" },
			status: HTTP_OK,
		});
	});

	it("skips a non-target action", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned(buildPayload({ action: "closed" }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "event-out-of-scope" },
			status: HTTP_OK,
		});
	});
});

describe("payload validation", () => {
	it("errors on a non-JSON pull_request body", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned("{not json");
		await expectReply(response, {
			body: { decision: "error", reason: "invalid-payload" },
			status: HTTP_INTERNAL_ERROR,
		});
	});

	it("errors on a payload missing pull_request fields", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned('{"action":"opened"}');
		await expectReply(response, {
			body: { decision: "error", reason: "invalid-payload" },
			status: HTTP_INTERNAL_ERROR,
		});
	});

	it("errors when the installation is absent", async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload({ installation: null }));
		await expectReply(response, {
			body: { decision: "error", reason: "missing-installation" },
			status: HTTP_INTERNAL_ERROR,
		});
		session.assertDone();
	});
});

describe("pull request state", () => {
	it("skips a draft pull request", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned(buildPayload({ draft: true }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "pr-draft" },
			status: HTTP_OK,
		});
	});

	it("skips a closed pull request", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned(buildPayload({ state: "closed" }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "pr-not-open" },
			status: HTTP_OK,
		});
	});

	it("skips when the head repository is gone", async () => {
		expect.hasAssertions();
		installFetchMock([]);
		const response = await postSigned(buildPayload({ headRepo: null }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "head-repo-missing" },
			status: HTTP_OK,
		});
	});
});

describe("owner approval flow", () => {
	it("approves the owner's pull request", async () => {
		expect.hasAssertions();
		const session = installFetchMock(happyRoutes());
		const response = await postSigned(buildPayload());
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
		const posted = requestByUrl(session, pullsUrl("octo", "/reviews"));
		expect(posted.body).toBe('{"commit_id":"head-sha","event":"APPROVE"}');
		session.assertDone();
	});

	it("splits the app jwt and the installation token across endpoints", async () => {
		expect.hasAssertions();
		const session = installFetchMock(happyRoutes());
		await postSigned(buildPayload());
		expect(requestByUrl(session, TOKEN_URL).headers["authorization"]).toMatch(JWT_PATTERN);
		expect(requestByUrl(session, APP_URL).headers["authorization"]).toMatch(JWT_PATTERN);
		expect(requestByUrl(session, pullsUrl("octo", COMMITS_SUFFIX)).headers["authorization"]).toBe(
			"Bearer install-token",
		);
		expect(requestByUrl(session, pullsUrl("octo", "/reviews")).headers["authorization"]).toBe(
			"Bearer install-token",
		);
	});

	it("emits one structured decision log", async () => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
		installFetchMock(happyRoutes());
		await postSigned(buildPayload());
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "opened",
				decision: "approved",
				deliveryId: DELIVERY_ID,
				headSha: HEAD_SHA,
				prNumber: PULL_NUMBER,
				repo: "octo/hello",
			}),
		);
		logSpy.mockRestore();
	});
});

describe("author trust", () => {
	it("approves an org owner author with a single membership lookup", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			membershipRoute({ payload: { role: "admin", state: "active" }, status: HTTP_OK }),
			...pipelineRoutes({ commits: [commitItem()], owner: "acme", reviews: [] }),
			reviewPostRoute("acme", HTTP_OK),
		]);
		const response = await postSigned(buildPayload({ repoOwner: ORG }));
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
		session.assertDone();
	});

	it("skips when the membership lookup returns 404", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			membershipRoute({ payload: { message: "Not Found" }, status: HTTP_NOT_FOUND }),
		]);
		const response = await postSigned(buildPayload({ repoOwner: ORG }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "author-not-trusted" },
			status: HTTP_OK,
		});
		session.assertDone();
	});

	it("approves an allowlisted renovate bot author", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			...pipelineRoutes({
				commits: [commitItem({ author: RENOVATE, committer: WEB_FLOW })],
				owner: "octo",
				reviews: [],
			}),
			reviewPostRoute("octo", HTTP_OK),
		]);
		const response = await postSigned(buildPayload({ user: RENOVATE }));
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
		session.assertDone();
	});
});

describe("commit conditions", () => {
	it("skips when the declared commit count is zero", async () => {
		expect.hasAssertions();
		const session = installFetchMock([tokenRoute()]);
		const response = await postSigned(buildPayload({ commits: 0 }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "no-commits" },
			status: HTTP_OK,
		});
		session.assertDone();
	});

	it("skips when the declared commit count exceeds the cap", async () => {
		expect.hasAssertions();
		const session = installFetchMock([tokenRoute()]);
		const response = await postSigned(buildPayload({ commits: MAX_VERIFIABLE_COMMITS + 1 }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "too-many-commits" },
			status: HTTP_OK,
		});
		session.assertDone();
	});

	it("skips on a commit count mismatch", async () => {
		expect.hasAssertions();
		const session = installFetchMock([tokenRoute(), commitsRouteFor("octo", [commitItem()])]);
		const response = await postSigned(buildPayload({ commits: 2 }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "commit-count-mismatch" },
			status: HTTP_OK,
		});
		session.assertDone();
	});
});

describe("commit verification", () => {
	it("skips an unverified commit", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			commitsRouteFor("octo", [commitItem({ verified: false })]),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "skipped", reason: "unverified-commit" },
			status: HTTP_OK,
		});
		session.assertDone();
	});

	it("skips a commit from an untrusted author", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			commitsRouteFor("octo", [commitItem({ author: STRANGER })]),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "skipped", reason: "untrusted-commit" },
			status: HTTP_OK,
		});
		session.assertDone();
	});
});

describe("duplicate approval check", () => {
	it("skips when its own approval already exists", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			commitsRouteFor("octo", [commitItem()]),
			appRoute(),
			reviewsRouteFor("octo", [OWN_APPROVAL]),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "skipped", reason: "already-approved" },
			status: HTTP_OK,
		});
		session.assertDone();
	});
});

describe("live state checks", () => {
	it("skips when the head moved", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			...pipelineRoutes({
				commits: [commitItem()],
				liveSha: "moved-sha",
				owner: "octo",
				reviews: [],
			}),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "skipped", reason: "head-moved" },
			status: HTTP_OK,
		});
		session.assertDone();
	});

	it("skips when the review post is rejected", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			...pipelineRoutes({ commits: [commitItem()], owner: "octo", reviews: [] }),
			reviewPostRoute("octo", HTTP_UNPROCESSABLE_ENTITY),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "skipped", reason: "review-rejected" },
			status: HTTP_OK,
		});
		session.assertDone();
	});
});

describe("github api failures", () => {
	it("errors when the commits request fails", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			jsonRoute({
				method: "GET",
				payload: { message: "boom" },
				status: HTTP_INTERNAL_ERROR,
				url: pullsUrl("octo", COMMITS_SUFFIX),
			}),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "error", reason: "github-api-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		session.assertDone();
	});

	it("errors when the commits request hits a network failure", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			jsonRoute({
				method: "GET",
				payload: {},
				status: 0,
				url: pullsUrl("octo", COMMITS_SUFFIX),
			}),
		]);
		const response = await postSigned(buildPayload());
		await expectReply(response, {
			body: { decision: "error", reason: "github-api-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		session.assertDone();
	});
});
