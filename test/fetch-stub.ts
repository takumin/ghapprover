/**
 * Strict per-test fetch stub standing in for the retired fetchMock helper
 * (this @cloudflare/vitest-pool-workers version no longer exports it from
 * "cloudflare:test"): serves the planned routes, records every request, and
 * rejects anything unplanned (the disableNetConnect equivalent). Responses
 * carry a JSON content-type (octokit only parses JSON bodies with one) plus
 * any planned extra headers, e.g. the link header pagination follows.
 *
 * Nothing about GitHub is stated here: this module serves whatever route it is handed. What the
 * routes are — the API origin, the fixture repository, the route templates and the statuses GitHub
 * answers them with — is stated in test/github-api.ts, and the statuses the Worker itself names are
 * imported from src/http-status.ts where a suite needs one, so that a suite asserting its own 413
 * cannot keep passing against a Worker that answers another.
 */
import { vi } from "vitest";

export interface PlannedRoute {
	readonly body: string;
	/** Extra response headers (e.g. link); the JSON content-type is implied. */
	readonly headers?: Readonly<Record<string, string>> | undefined;
	readonly method: string;
	/** How a status-0 route rejects: a network TypeError (default) or an expired timeout signal. */
	readonly rejectAs?: "timeout";
	/** Status 0 makes the stub reject instead of responding. */
	readonly status: number;
	readonly url: string;
}
export interface RecordedRequest {
	readonly body: string;
	readonly headers: Readonly<Record<string, string>>;
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

/* The pending list is taken from, not read: a matched route is spliced out so it is served once,
 * which is what leaves an unconsumed one for the session to assert on afterwards. The mutation is
 * the point, so this parameter is the one here that cannot be readonly. */
// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- the pending list is consumed in place; see above
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
	readonly headers?: Readonly<Record<string, string>> | undefined;
	readonly method: string;
	readonly payload: unknown;
	readonly status: number;
	readonly url: string;
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
