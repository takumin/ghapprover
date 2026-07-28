/**
 * Strict per-test fetch stub standing in for the retired fetchMock helper
 * (this @cloudflare/vitest-pool-workers version no longer exports it from
 * "cloudflare:test"): serves the planned routes, records every request, and
 * rejects anything unplanned (the disableNetConnect equivalent). Responses
 * carry a JSON content-type (octokit only parses JSON bodies with one) plus
 * any planned extra headers, e.g. the link header pagination follows.
 */
import { vi } from "vitest";

const HTTP_CREATED = 201;
/** App JWT authorization: "bearer" plus three dot-separated base64url segments. */
export const JWT_PATTERN = /^bearer eyJ[\w-]+\.[\w-]+\.[\w-]+$/u;

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
	readonly url: string;
}
export interface FetchMockSession {
	readonly assertDone: () => void;
	readonly requests: readonly RecordedRequest[];
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
