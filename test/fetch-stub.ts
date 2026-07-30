/**
 * Strict per-test fetch stub standing in for the retired fetchMock helper
 * (this @cloudflare/vitest-pool-workers version no longer exports it from
 * "cloudflare:test"): serves the planned routes, records every request, and
 * rejects anything unplanned (the disableNetConnect equivalent). Responses
 * carry a JSON content-type (octokit only parses JSON bodies with one) plus
 * any planned extra headers, e.g. the link header pagination follows.
 *
 * The statuses a route is planned with and a response asserted against are stated here too, this
 * being the one module every suite imports: a suite must not pick up a different 403 from whichever
 * helper module it happened to import. What the routes themselves are — the API origin, the fixture
 * repository, and the route templates — is stated in test/github-api.ts.
 */
import { vi } from "vitest";

export const HTTP_OK = 200;
export const HTTP_CREATED = 201;
export const HTTP_UNAUTHORIZED = 401;
export const HTTP_FORBIDDEN = 403;
export const HTTP_NOT_FOUND = 404;
export const HTTP_PAYLOAD_TOO_LARGE = 413;
export const HTTP_UNPROCESSABLE_ENTITY = 422;
export const HTTP_INTERNAL_ERROR = 500;

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

/** The recorded request for a planned URL; absence is a test-setup failure, not an assertion. */
export function requestByUrl(session: FetchMockSession, url: string): RecordedRequest {
	const found = session.requests.find((entry) => entry.url === url);
	if (found === undefined) {
		throw new Error(`request not recorded: ${url}`);
	}
	return found;
}
