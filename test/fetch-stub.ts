/**
 * Strict per-test fetch stub standing in for the retired fetchMock helper
 * (this @cloudflare/vitest-pool-workers version no longer exports it from
 * "cloudflare:test"): serves the planned routes, records every request, and
 * rejects anything unplanned (the disableNetConnect equivalent).
 */
import { vi } from "vitest";

export interface PlannedRoute {
	readonly body: string;
	readonly method: string;
	/** Status 0 makes the stub reject like a network failure. */
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
		return new Response(route.body, { status: route.status });
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
	method: string;
	payload: unknown;
	status: number;
	url: string;
}): PlannedRoute {
	return {
		body: JSON.stringify(route.payload),
		method: route.method,
		status: route.status,
		url: route.url,
	};
}
