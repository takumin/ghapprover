/**
 * One webhook delivery, end to end: the signed request the Worker is handed, the env it runs
 * against, and the planned routes a full run consumes (SPEC.md §4). Shared by the suite that drives
 * the entry point (index.test.ts) and the ones that drive the pipeline behind it
 * (pipeline*.test.ts), so a delivery is built the same way in all of them. The routes themselves
 * come whole from test/github-api.ts, which is where every suite's routes are built — what belongs
 * here is only the order a run consumes them in, a route stated twice being one that can disagree
 * with itself about what the pipeline actually calls.
 */

import { APP_BOT, HEAD_SHA, OWNER, PULL_NUMBER, REPOSITORY, repositoryOwnedBy } from "./fixtures";
import {
	APP_ID,
	INSTALLATION_ID,
	appRoute,
	commitItem,
	commitsRoute,
	installTokenRoute,
	livePullRequestRoute,
	reviewPostRoute,
	reviewsRoute,
} from "./github-api";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, onTestFinished, vi } from "vitest";
import worker, { MAX_BODY_BYTES } from "../src/index";
import type { GithubAccount } from "../src/types";
import { HTTP_OK } from "./fetch-stub";
import type { MockInstance } from "vitest";
import type { PlannedRoute } from "./fetch-stub";
import { privateKeyPemOnce } from "./app-key";
import { sign } from "@octokit/webhooks-methods";

/** One byte past the cap the Worker enforces, taken from the cap itself (SPEC.md §9). */
export const OVERSIZED_BODY_BYTES = MAX_BODY_BYTES + 1;

export const WEBHOOK_URL = "http://example.com/webhook";
export const SECRET = "test-secret";
export const DELIVERY_ID = "delivery-42";

export const OWN_APPROVAL = { commit_id: HEAD_SHA, state: "APPROVED", user: APP_BOT };

/** The env a delivery runs against; a case about the configuration itself overrides the one secret it is about. */
export async function makeEnv(overrides: Partial<Env> = {}): Promise<Env> {
	const env: Env = {
		GITHUB_APP_ID: APP_ID,
		GITHUB_APP_PRIVATE_KEY: await privateKeyPemOnce(),
		GITHUB_WEBHOOK_SECRET: SECRET,
	};
	return Object.assign(env, overrides);
}

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
		/** The head repo defaults to the fixture repository itself, so a PR is not a fork. */
		headRepo = { id: REPOSITORY.id },
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
		repository: repositoryOwnedBy(repoOwner),
	});
}

interface PipelineRoutesOptions {
	readonly commits: readonly unknown[];
	readonly liveSha?: string;
	readonly owner?: GithubAccount;
	readonly reviews: readonly unknown[];
}

/** The GET routes every full pipeline run consumes after token issuance. */
export function pipelineRoutes(options: PipelineRoutesOptions): PlannedRoute[] {
	const { commits, liveSha = HEAD_SHA, owner = OWNER, reviews } = options;
	return [
		commitsRoute(commits, owner),
		appRoute(),
		reviewsRoute(reviews, owner),
		livePullRequestRoute(liveSha, owner),
	];
}

export function happyRoutes(): PlannedRoute[] {
	return [
		installTokenRoute(),
		...pipelineRoutes({ commits: [commitItem()], reviews: [] }),
		reviewPostRoute(HTTP_OK),
	];
}

export async function dispatch(request: Request, env?: Env): Promise<Response> {
	const ctx = createExecutionContext();
	const response = await worker.fetch(request, env ?? (await makeEnv()), ctx);
	await waitOnExecutionContext(ctx);
	return response;
}

/** What GitHub sends besides the signature; stated apart from it for the case about a delivery carrying none. */
export function unsignedDeliveryHeaders(eventName = "pull_request"): Record<string, string> {
	return { "x-github-delivery": DELIVERY_ID, "x-github-event": eventName };
}
/** The three headers GitHub sends on every delivery; cases vary the signature and the event. */
export function deliveryHeaders(
	signature: string,
	eventName = "pull_request",
): Record<string, string> {
	const headers = unsignedDeliveryHeaders(eventName);
	return Object.assign(headers, { "x-hub-signature-256": signature });
}
/** The POST a delivery arrives as, however the case arrived at its headers. */
export function deliveryRequest(body: string, headers: Record<string, string>): Request {
	return new Request(WEBHOOK_URL, { body, headers, method: "POST" });
}
/** The same POST correctly signed over its own body; a case adds the headers GitHub would have sent with it. */
export async function signedDelivery(
	body: string,
	extraHeaders: Record<string, string> = {},
	eventName = "pull_request",
): Promise<Request> {
	const headers = deliveryHeaders(await sign(SECRET, body), eventName);
	return deliveryRequest(body, Object.assign(headers, extraHeaders));
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
	return dispatch(await signedDelivery(body, {}, eventName), env);
}

/* The spy on the one §8 log entry a delivery leaves, installed before the delivery is dispatched
 * and restored when the test finishes rather than by the test itself: a suite that asserted the
 * entry and forgot the restore would leak the spy into the next one, and the failure would land
 * wherever that happened to matter. Each caller is left stating only the entry it expects. */
export function captureLog(): MockInstance<typeof console.log> {
	const spy = vi.spyOn(console, "log");
	onTestFinished(() => {
		spy.mockRestore();
	});
	return spy;
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

/*
 * The §9 reply, as the three decisions it can announce. An evaluation that completed answers 200
 * whether or not it approved, so that pairing is stated here once instead of beside every reason a
 * suite is actually about — a suite spelling the pair itself is one that can assert a skip against
 * a status §9 never gives it and still pass. An error is the one decision whose status varies by
 * reason, which is why that one alone is named at the call.
 */
export async function expectApproved(response: Response): Promise<void> {
	return expectReply(response, { body: { decision: "approved" }, status: HTTP_OK });
}
export async function expectSkipped(response: Response, reason: string): Promise<void> {
	return expectReply(response, { body: { decision: "skipped", reason }, status: HTTP_OK });
}
export async function expectError(
	response: Response,
	reason: string,
	status: number,
): Promise<void> {
	return expectReply(response, { body: { decision: "error", reason }, status });
}
