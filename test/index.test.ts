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
import { privateKeyPemOnce } from "./app-key";
import worker from "../src/index";

/** Derived from the harness so "./fetch-stub" stays a single import (no-duplicate-imports). */
type FetchMockSession = ReturnType<typeof installFetchMock>;
type PlannedRoute = ReturnType<typeof jsonRoute>;
type RecordedRequest = FetchMockSession["requests"][number];

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_ERROR = 500;
/** One byte past GitHub's 25 MB webhook payload cap. */
const OVERSIZED_BODY_BYTES = 26_214_401;

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
const COMMITS_SUFFIX = "/commits?per_page=100";
const REVIEWS_SUFFIX = "/reviews?per_page=100";
/** App JWT authorization: "bearer" plus three dot-separated base64url segments. */
const JWT_PATTERN = /^bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/u;

const OWNER: GithubAccount = { id: 7, login: "octo", type: "User" };
const ORG: GithubAccount = { id: 88, login: "acme", type: "Organization" };
const RENOVATE: GithubAccount = { id: 29_139_614, login: "renovate[bot]", type: "Bot" };
const AUTOFIX_CI: GithubAccount = { id: 114_827_586, login: "autofix-ci[bot]", type: "Bot" };
const WEB_FLOW: GithubAccount = { id: 19_864_447, login: "web-flow", type: "User" };
const STRANGER: GithubAccount = { id: 999, login: "mallory", type: "User" };
/** The allowlisted renovate login under a different account (SPEC.md §3.1 id pinning). */
const RENOVATE_WRONG_ID: GithubAccount = { id: 2, login: "renovate[bot]", type: "Bot" };
const APP_BOT_USER: GithubAccount = { id: 201, login: "ghapprover[bot]", type: "Bot" };
const OWN_APPROVAL = { commit_id: HEAD_SHA, state: "APPROVED", user: APP_BOT_USER };

const HEX_RADIX = 16;
const HEX_PAD = 2;

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

/** The base repository id; the head repo defaults to the same one, so PRs are not forks. */
const REPO_ID = 555;

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
		headRepo = { id: REPO_ID },
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
		repository: {
			full_name: `${repoOwner.login}/hello`,
			id: REPO_ID,
			name: "hello",
			owner: repoOwner,
		},
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
		payload: { expires_at: "2126-01-01T00:00:00Z", token: INSTALL_TOKEN },
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

async function dispatch(request: Request, env?: Env): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env ?? (await makeEnv()), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

async function postSigned(body: string, eventName = "pull_request", env?: Env): Promise<Response> {
	const request = new Request(WEBHOOK_URL, {
		body,
		headers: {
			"x-github-delivery": DELIVERY_ID,
			"x-github-event": eventName,
			"x-hub-signature-256": await signBody(SECRET, body),
		},
		method: "POST",
	});
	return dispatch(request, env);
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

	/* SPEC.md §8: a webhook URL pointing at the wrong path is what not-found exists to
	 * surface, so the 404 has to be greppable in the logs, not only in the response body. */
	it("logs the not-found decision", async () => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
		installFetchMock([]);
		await dispatch(new Request(WEBHOOK_URL, { method: "GET" }));
		expect(logSpy).toHaveBeenCalledWith({ decision: "error", reason: "not-found" });
		logSpy.mockRestore();
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

	it("skips a fork pull request without dispatching a single call", async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload({ headRepo: { id: REPO_ID + 1 } }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "head-repo-forked" },
			status: HTTP_OK,
		});
		expect(session.requests).toHaveLength(0);
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
			"token install-token",
		);
		expect(requestByUrl(session, pullsUrl("octo", "/reviews")).headers["authorization"]).toBe(
			"token install-token",
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

/* The shape autofix.ci pushes onto a bot PR (author autofix-ci[bot], committer web-flow,
 * GitHub-signed): without the allowlist entry this commit makes the PR permanently
 * unapprovable, which is exactly the PR ghapprover exists to approve (SPEC.md §3.1). */
describe("autofix.ci commits", () => {
	it("approves a renovate pull request carrying an autofix.ci commit", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			...pipelineRoutes({
				commits: [
					commitItem({ author: RENOVATE, committer: WEB_FLOW }),
					commitItem({ author: AUTOFIX_CI, committer: WEB_FLOW }),
				],
				owner: "octo",
				reviews: [],
			}),
			reviewPostRoute("octo", HTTP_OK),
		]);
		const response = await postSigned(buildPayload({ commits: 2, user: RENOVATE }));
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
		session.assertDone();
	});
});

describe("commit conditions", () => {
	it("skips when the declared commit count is zero, with no api call", async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload({ commits: 0 }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "no-commits" },
			status: HTTP_OK,
		});
		session.assertDone();
	});

	it("skips when the declared commit count exceeds the cap, with no api call", async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
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

	it("stops before any principal lookup when the first commit is unverified", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			membershipRoute({ payload: { role: "admin", state: "active" }, status: HTTP_OK }),
			commitsRouteFor("acme", [
				commitItem({ author: STRANGER, verified: false }),
				commitItem({ author: STRANGER }),
			]),
		]);
		const response = await postSigned(buildPayload({ commits: 2, repoOwner: ORG }));
		await expectReply(response, {
			body: { decision: "skipped", reason: "unverified-commit" },
			status: HTTP_OK,
		});
		session.assertDone();
	});
});

describe("principal trust resolution", () => {
	/* SPEC.md §3.1: the per-delivery memo is keyed on the account, not the login. The PR author
	 * resolves renovate[bot] to trusted without a lookup; a commit author reusing that login
	 * under another id must still be classified on its own, or the §3.1 id pinning is dead
	 * weight — every check upstream of the cache already pins it. */
	it("does not extend a trusted verdict to another id on the same login", async () => {
		expect.hasAssertions();
		const session = installFetchMock([
			tokenRoute(),
			commitsRouteFor("octo", [commitItem({ author: RENOVATE_WRONG_ID, committer: WEB_FLOW })]),
		]);
		const response = await postSigned(buildPayload({ user: RENOVATE }));
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

/** The PKCS#1 PEM shape GitHub serves, which the auth library rejects at import (SPEC.md §7). */
const PKCS1_KEY_ENV: Env = {
	GITHUB_APP_ID: "12345",
	GITHUB_APP_PRIVATE_KEY: "-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n",
	GITHUB_WEBHOOK_SECRET: SECRET,
};

describe("auth configuration failures", () => {
	it("errors with a bounded diagnostic when the private key is rejected", async () => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
		const session = installFetchMock([]);
		const response = await postSigned(buildPayload(), "pull_request", PKCS1_KEY_ENV);
		await expectReply(response, {
			body: { decision: "error", reason: "internal-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({ errorName: "Error", reason: "internal-error" }),
		);
		logSpy.mockRestore();
		session.assertDone();
	});

	it("errors loudly when the installation token cannot be issued", async () => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
		const session = installFetchMock([
			jsonRoute({
				method: "POST",
				payload: { message: "Not Found" },
				status: HTTP_NOT_FOUND,
				url: TOKEN_URL,
			}),
		]);
		const response = await postSigned(buildPayload({ repoOwner: ORG }));
		await expectReply(response, {
			body: { decision: "error", reason: "github-api-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				endpoint: "POST /app/installations/{installation_id}/access_tokens",
				status: HTTP_NOT_FOUND,
			}),
		);
		logSpy.mockRestore();
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

/** A signed delivery declaring an explicit Content-Length, which postSigned leaves unset. */
async function postSignedWithLength(body: string, contentLength: number): Promise<Response> {
	const request = new Request(WEBHOOK_URL, {
		body,
		headers: {
			"content-length": String(contentLength),
			"x-github-delivery": DELIVERY_ID,
			"x-github-event": "pull_request",
			"x-hub-signature-256": await signBody(SECRET, body),
		},
		method: "POST",
	});
	return dispatch(request);
}

describe("request body limits", () => {
	it("rejects a Content-Length above the 25 MB webhook cap before reading the body", async () => {
		expect.hasAssertions();
		const session = installFetchMock([]);
		const response = await postSignedWithLength(buildPayload(), OVERSIZED_BODY_BYTES);
		await expectReply(response, {
			body: { decision: "error", reason: "payload-too-large" },
			status: HTTP_PAYLOAD_TOO_LARGE,
		});
		expect(session.requests).toHaveLength(0);
	});

	it("processes a delivery whose Content-Length is within the cap", async () => {
		expect.hasAssertions();
		installFetchMock(happyRoutes());
		const body = buildPayload();
		const response = await postSignedWithLength(body, new TextEncoder().encode(body).length);
		await expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
	});
});

/* A body whose stream errors mid-read: what a client disconnect or a truncated chunked upload
 * looks like to the Worker. duplex is required by the Fetch spec for a stream body. */
function requestWithFailingBody(): Request {
	const init = {
		body: new ReadableStream({
			start(controller: ReadableStreamDefaultController): void {
				controller.error(new TypeError("connection reset"));
			},
		}),
		duplex: "half",
		headers: {
			"x-github-delivery": DELIVERY_ID,
			"x-github-event": "pull_request",
			"x-hub-signature-256": "sha256=00",
		},
		method: "POST",
	};
	return new Request(WEBHOOK_URL, init);
}

describe("unreadable deliveries", () => {
	/* SPEC.md §8 requires one log entry per delivery and §9 maps any other thrown failure to
	 * internal-error. Reading the body runs before the pipeline's own guard, so without a
	 * catch-all this delivery would answer with the runtime's 500 and log nothing at all. */
	it("errors with a bounded diagnostic when the body cannot be read", async () => {
		expect.hasAssertions();
		const logSpy = vi.spyOn(console, "log");
		const session = installFetchMock([]);
		await expectReply(await dispatch(requestWithFailingBody()), {
			body: { decision: "error", reason: "internal-error" },
			status: HTTP_INTERNAL_ERROR,
		});
		expect(logSpy).toHaveBeenCalledWith(
			expect.objectContaining({
				decision: "error",
				deliveryId: DELIVERY_ID,
				reason: "internal-error",
			}),
		);
		logSpy.mockRestore();
		session.assertDone();
	});
});
