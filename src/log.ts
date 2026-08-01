/**
 * The one structured log entry every delivery leaves (SPEC.md §8): the fields known from the
 * headers alone, the payload fields known once the body is modeled, and the outcome fields known
 * last — accumulated onto one record and emitted once. Split from the entry point (src/index.ts)
 * because that module owns the delivery's control flow and this one owns the shape of what it
 * reports; §8 is a contract with an operator's grep, and it is not the reading of a body or the
 * routing of a request that changes it.
 */

import type { Outcome } from "./outcome";
import type { PullRequestEventPayload } from "./types";

/** SPEC.md §8 flat log entry, accumulating fields as they become known per delivery. */
type LogFields = Record<string, number | string>;

/*
 * The bounds on the two §8 fields whose source imposes none. Stated together because they are one
 * rule rather than two slices: a field this entry copies verbatim from something outside this
 * Worker is bounded where the entry is built, not at each place a value can reach it (SPEC.md §12).
 * Both are exported for the suites that drive the truncation, which state the overlong value as the
 * bound plus one rather than as a literal of their own — a literal keeps passing once a bound moves.
 */
/**
 * A delivery id is a 36-character UUID, so this is headroom over that shape rather
 * than a fit to it: every id GitHub actually sends passes through whole, and a value
 * this does cut is therefore not a delivery id at all — the entry never carries a
 * prefix an operator could mistake for one and grep Recent Deliveries for in vain.
 * The bound is what the field's position costs: it is filled from the headers before
 * the route check, before the webhook secret is looked at and before the signature is
 * verified (src/index.ts), because §8 requires it on `payload-too-large`,
 * `missing-webhook-secret` and `invalid-signature` — which makes it the one §8 field
 * an unauthenticated caller writes into, on every request the Worker receives. This
 * bounds the size of such an entry and not the number of them; that is a rate limit at
 * the edge rather than anything this Worker can decide.
 */
const MAX_DELIVERY_ID_CHARS = 64;
/**
 * @octokit/request builds an error message from the response body and takes the whole
 * body when that body is not JSON (an HTML error page from GitHub or a proxy in front
 * of it), so the message arrives unbounded however short the error it names.
 */
const MAX_ERROR_MESSAGE_CHARS = 512;

/* SPEC.md §8: X-GitHub-Delivery is the only identifier GitHub's Recent Deliveries shows for a
 * failed delivery, so it is what an operator carries into the logs. It is known from the headers
 * alone, which is why this is the first of the three to run and every later field lands on the
 * record it leaves behind. The deployed version id is known just as early — it is a binding, not
 * anything the request carries — and is what says which build produced the entry, so the two are
 * set together and both survive on a delivery rejected before its body is read. Like recordPayload
 * it writes into the record it is handed rather than returning one of its own, which is what lets
 * the caller derive these inside the frame that guarantees the entry (src/index.ts): reaching
 * through a binding can throw like anything else there, and an entry naming that throw and
 * carrying neither field is still an entry. */
function recordDelivery(log: LogFields, request: Request, env: Env): void {
	const deliveryId = request.headers.get("x-github-delivery");
	if (deliveryId !== null) {
		log["deliveryId"] = deliveryId.slice(0, MAX_DELIVERY_ID_CHARS);
	}
	log["versionId"] = env.CF_VERSION_METADATA.id;
}

function recordPayload(log: LogFields, payload: PullRequestEventPayload): void {
	log["action"] = payload.action;
	log["headSha"] = payload.pull_request.head.sha;
	log["prNumber"] = payload.pull_request.number;
	log["repo"] = payload.repository.full_name;
}

/** The §8 fields an outcome carries only for the outcomes they apply to, in that table's order; httpStatus is not logged. */
const OPTIONAL_LOG_FIELDS = [
	"reason",
	"endpoint",
	"status",
	"requestId",
	"acceptedPermissions",
	"rateLimitRemaining",
	"rateLimitReset",
	"errorName",
	"field",
] as const;
/** Resolves only when Field is never; used as a compile-time assertion below. */
type NoneOf<Field extends never> = Field;
/**
 * Compile-time check that every §8 field an outcome can carry reaches the entry:
 * `decision` and `errorMessage` are logged by name in logOutcome, `httpStatus` is
 * the §9 response status rather than a log field, and the rest must be listed
 * above. Without this, a field added to Outcome (src/outcome.ts) and populated on
 * a failure path would simply never be logged — an observability gap no type error
 * or test failure would surface.
 */
type AllOutcomeFieldsLogged = NoneOf<
	Exclude<
		keyof Outcome,
		"decision" | "errorMessage" | "httpStatus" | (typeof OPTIONAL_LOG_FIELDS)[number]
	>
>;
/** Exactly one structured log entry per handled webhook delivery (SPEC.md §8). */
function logOutcome(log: LogFields, outcome: Outcome): void {
	log["decision"] = outcome.decision;
	for (const key of OPTIONAL_LOG_FIELDS) {
		const value = outcome[key];
		if (value !== undefined) {
			log[key] = value;
		}
	}
	const { errorMessage } = outcome;
	if (errorMessage !== undefined) {
		log["errorMessage"] = errorMessage.slice(0, MAX_ERROR_MESSAGE_CHARS);
	}
	// oxlint-disable-next-line eslint/no-console -- §8's one entry: `console` is the only sink a Worker has
	console.log(log);
}

export {
	MAX_DELIVERY_ID_CHARS,
	MAX_ERROR_MESSAGE_CHARS,
	logOutcome,
	recordDelivery,
	recordPayload,
};
export type { AllOutcomeFieldsLogged, LogFields };
