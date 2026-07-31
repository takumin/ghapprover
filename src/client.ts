/**
 * The per-delivery GitHub client (SPEC.md §11): @octokit/core issues the requests,
 * @octokit/plugin-paginate-rest follows the Link header for pagination, and
 * @octokit/auth-app signs the App JWT and issues installation tokens (cached in memory
 * per client, SPEC.md §7). What every call shares is here — the client and the delivery
 * budget — apart from what each endpoint maps for itself (src/github.ts) and from what a
 * failed call becomes (src/api-error.ts).
 */

import { Octokit } from "@octokit/core";
import { createAppAuth } from "@octokit/auth-app";
import { paginateRest } from "@octokit/plugin-paginate-rest";

const API_VERSION = "2022-11-28";
const USER_AGENT = "ghapprover";
/**
 * Whole-delivery budget, shared by every call the client makes (SPEC.md §4;
 * §9: no retries inside the Worker, but a deadline on every call). Without it
 * a delivery could outlive GitHub's 10-second webhook timeout and land an
 * approval whose delivery is recorded as failed, so it is set below that
 * timeout to leave room for the signature check and the response. A
 * per-dispatch budget on top would never bind: it starts at or after this one,
 * so it could only fire first by being shorter than the whole delivery — which
 * is this budget again.
 *
 * The value also absorbs the one thing the signal cannot abort: @octokit/auth-app
 * waits between its 401 retries on a plain timer, so a wait in flight when this
 * expires runs to its end before the next dispatch aborts. Only one can be in
 * flight (that dispatch fails as a timeout rather than a 401, which ends the
 * retry loop), so the overrun is bounded by the longest single wait, 3 s. Hence
 * 6 s: 6 + 3 clears the 10-second timeout with room for the body read, the HMAC,
 * and the response (SPEC.md §4, §9).
 */
const DELIVERY_TIMEOUT_MS = 6000;

const GithubOctokit = Octokit.plugin(paginateRest);

/** Per-delivery client with App auth and Link-header pagination wired in. */
export type GithubClient = InstanceType<typeof GithubOctokit>;

export interface AppCredentials {
	/** GitHub App ID (or client ID), the `iss` claim of the App JWT. */
	readonly appId: string;
	/** GitHub App private key PEM, converted to PKCS#8 (SPEC.md §7). */
	readonly privateKeyPem: string;
}

/**
 * Creates the per-delivery client. @octokit/auth-app authenticates the app
 * endpoints (e.g. GET /app) with the App JWT and everything else with an
 * installation token it issues lazily on first use. A before-request hook
 * pins the REST API version on every request, and the request signal caps the
 * delivery as a whole: octokit keeps it as a client-level default, the only
 * form that reaches all three kinds of dispatch — plain calls, pagination
 * follow-up pages (which carry no per-call request options), and the auth
 * strategy's internal token request, which is issued through this same client.
 * One signal for all of them caps their sum; it aborts as TimeoutError, which
 * src/api-error.ts maps to status 0 (SPEC.md §4, §9, §11). The delivery budget
 * starts here, so the client is created once per delivery — with the one
 * exception that @octokit/auth-app dedupes in-flight token issuance
 * process-wide by installation id, so overlapping deliveries can share the
 * first one's token request and therefore its deadline (accepted, SPEC.md §9).
 */
export function createGithubClient(
	credentials: AppCredentials,
	installationId: number,
): GithubClient {
	const client = new GithubOctokit({
		auth: {
			appId: credentials.appId,
			installationId,
			privateKey: credentials.privateKeyPem,
		},
		authStrategy: createAppAuth,
		request: { signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS) },
		userAgent: USER_AGENT,
	});
	/* The one parameter here that is written into rather than read, and the hook contract is what
	 * writes it: octokit hands each dispatch its own options and takes the header back off them.
	 * Exempted per line rather than by name — the type it arrives as resolves to none. */
	// oxlint-disable-next-line typescript/prefer-readonly-parameter-types -- the before-request hook pins the header by writing into the options octokit hands it
	client.hook.before("request", (options) => {
		options.headers["x-github-api-version"] = API_VERSION;
	});
	return client;
}
