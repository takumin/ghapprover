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

/* SPEC.md §8: X-GitHub-Delivery is the only identifier GitHub's Recent Deliveries shows for a
 * failed delivery, so it is what an operator carries into the logs. It is known from the headers
 * alone, which is why every entry starts from this rather than from an empty field set. */
function deliveryFields(request: Request): LogFields {
	const log: LogFields = {};
	const deliveryId = request.headers.get("x-github-delivery");
	if (deliveryId !== null) {
		log["deliveryId"] = deliveryId;
	}
	return log;
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
/**
 * The one bound on the one §8 field that has none at its source: @octokit/request
 * builds an error message from the response body and takes the whole body when
 * that body is not JSON (an HTML error page from GitHub or a proxy in front of
 * it). Truncating here, where the entry is built, is what makes it one rule for
 * every path onto the field rather than one per place an error is raised
 * (SPEC.md §12). Exported for the suite that drives the truncation, which builds
 * a message past the bound out of the bound itself.
 */
const MAX_ERROR_MESSAGE_CHARS = 512;
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

export { MAX_ERROR_MESSAGE_CHARS, deliveryFields, logOutcome, recordPayload };
export type { AllOutcomeFieldsLogged, LogFields };
