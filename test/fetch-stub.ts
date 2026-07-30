/**
 * Strict per-test fetch stub standing in for the retired fetchMock helper
 * (this @cloudflare/vitest-pool-workers version no longer exports it from
 * "cloudflare:test"): serves the planned routes, records every request, and
 * rejects anything unplanned (the disableNetConnect equivalent). Responses
 * carry a JSON content-type (octokit only parses JSON bodies with one) plus
 * any planned extra headers, e.g. the link header pagination follows.
 *
 * It is also where the values every suite states about a call — the statuses and
 * headers a response carries, and the origin, pull request and route templates the
 * requests are built and asserted against — are declared, this being the one module
 * both route-helper families (delivery.ts, github-routes.ts) and every suite import.
 */
import { vi } from "vitest";

/* The statuses the suites plan routes with and assert responses against. Stated here, in the one
 * module every suite and every route helper imports, so that a suite cannot pick up a different 403
 * from whichever helper module it happened to import. */
export const HTTP_OK = 200;
const HTTP_CREATED = 201;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_PAYLOAD_TOO_LARGE = 413;
export const HTTP_UNPROCESSABLE_ENTITY = 422;
export const HTTP_INTERNAL_ERROR = 500;
/** App JWT authorization: "bearer" plus three dot-separated base64url segments. */
export const JWT_PATTERN = /^bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/u;
/* The API origin and the pull request number both route-helper families build their URLs from.
 * Stated here for the same reason as the statuses: the two families build the same
 * /repos/{owner}/{repo}/pulls/{n} routes from their own fixture values, and a URL they disagree
 * about is an unplanned request in whichever suite was not updated. */
export const BASE = "https://api.github.com";
export const PULL_NUMBER = 5;
/* The route templates SPEC.md §8's `endpoint` names, which is the vocabulary an operator greps: one
 * suite drives the call that raises them (github.test.ts, client.test.ts) and another the log entry
 * they end up in (pipeline-failures.test.ts), so a template stated per suite is one that can be
 * corrected in the one that fails and left wrong in the one that still passes. */
export const TOKEN_ENDPOINT = "POST /app/installations/{installation_id}/access_tokens";
export const COMMITS_ENDPOINT = "GET /repos/{owner}/{repo}/pulls/{pull_number}/commits";
export const REVIEW_POST_ENDPOINT = "POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews";
/**
 * The headers GitHub sends on a refused call, which SPEC.md §8 logs alongside the status. Shared by
 * the suite that drives the mapping (client.test.ts) and the one that drives the log entry it ends
 * up in (pipeline-failures.test.ts): the §8 diagnostics set stated twice is a set that can be
 * extended in one suite and asserted in the other without either failing.
 */
export const REFUSAL_HEADERS = {
	"x-accepted-github-permissions": "pull_requests=write",
	"x-github-request-id": "F1E2:3D4C",
	"x-ratelimit-remaining": "0",
	"x-ratelimit-reset": "1770000000",
};

export interface PlannedRoute {
	readonly body: string;
	/** Extra response headers (e.g. link); the JSON content-type is implied. */
	readonly headers?: Record<string, string> | undefined;
	readonly method: string;
	/** How a status-0 route rejects: a network TypeError (default) or an expired timeout signal. */
	readonly rejectAs?: "timeout";
	/** Status 0 makes the stub reject instead of responding. */
	readonly status: number;
	readonly url: string;
}
export interface RecordedRequest {
	readonly body: string;
	readonly headers: Record<string, string>;
	readonly method: string;
	/** The signal the dispatch carried, to assert the delivery budget reaches every call. */
	readonly signal: AbortSignal | undefined;
	readonly url: string;
}
export interface FetchMockSession {
	readonly assertDone: () => void;
	readonly requests: readonly RecordedRequest[];
}

/* The signal the caller put on the dispatch, so a test can assert the delivery budget reached it.
 * Spelled out rather than optional-chained: oxc/no-optional-chaining is on. */
function dispatchedSignal(init: RequestInit | undefined): AbortSignal | undefined {
	if (init === undefined) {
		return undefined;
	}
	return init.signal ?? undefined;
}

/** JSON content-type first (octokit only parses JSON with one), then the planned extras. */
function responseHeaders(route: PlannedRoute): Record<string, string> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	for (const [name, value] of Object.entries(route.headers ?? {})) {
		headers[name] = value;
	}
	return headers;
}

function takeRoute(pending: PlannedRoute[], request: Request): PlannedRoute {
	const index = pending.findIndex(
		(route) => route.method === request.method && route.url === request.url,
	);
	const route = pending[index];
	if (route === undefined) {
		throw new TypeError(`unplanned request: ${request.method} ${request.url}`);
	}
	pending.splice(index, 1);
	if (route.status === 0) {
		if (route.rejectAs === "timeout") {
			throw new DOMException("The operation timed out.", "TimeoutError");
		}
		throw new TypeError("simulated network failure");
	}
	return route;
}

export function installFetchMock(routes: readonly PlannedRoute[]): FetchMockSession {
	const pending = [...routes];
	const requests: RecordedRequest[] = [];
	const handler = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		const request = new Request(input, init);
		const bodyText = await request.text();
		const route = takeRoute(pending, request);
		requests.push({
			body: bodyText,
			headers: Object.fromEntries(request.headers),
			method: request.method,
			signal: dispatchedSignal(init),
			url: request.url,
		});
		return new Response(route.body, { headers: responseHeaders(route), status: route.status });
	};
	vi.stubGlobal("fetch", handler);
	return {
		assertDone: (): void => {
			if (pending.length > 0) {
				throw new Error(
					`unconsumed planned routes: ${pending.map((route) => route.url).join(", ")}`,
				);
			}
		},
		requests,
	};
}

export function jsonRoute(route: {
	headers?: Record<string, string> | undefined;
	method: string;
	payload: unknown;
	status: number;
	url: string;
}): PlannedRoute {
	return {
		body: JSON.stringify(route.payload),
		headers: route.headers,
		method: route.method,
		status: route.status,
		url: route.url,
	};
}

/**
 * The installation token the auth strategy issues lazily inside whichever
 * installation-authed call runs first. The expiry is far enough out that the
 * strategy never treats the stub token as stale.
 */
export function tokenRoute(route: { readonly token: string; readonly url: string }): PlannedRoute {
	return jsonRoute({
		method: "POST",
		payload: { expires_at: "2126-01-01T00:00:00Z", token: route.token },
		status: HTTP_CREATED,
		url: route.url,
	});
}

/** The recorded request for a planned URL; absence is a test-setup failure, not an assertion. */
export function requestByUrl(session: FetchMockSession, url: string): RecordedRequest {
	const found = session.requests.find((entry) => entry.url === url);
	if (found === undefined) {
		throw new Error(`request not recorded: ${url}`);
	}
	return found;
}
