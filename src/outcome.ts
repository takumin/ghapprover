/**
 * What a delivery can conclude, and the vocabulary it concludes in (SPEC.md §8, §9): the reason
 * names an operator greps for, the §9 status each of them answers with, and the §8 diagnostics an
 * outcome carries beyond its reason. Split from the pipeline (src/pipeline.ts) because the two
 * halves are read by different callers — the pipeline decides *which* outcome a delivery reaches,
 * while the entry point (src/index.ts) reads what any outcome is made of in order to log and answer
 * with it, without running a single §3 check.
 */

import type { ApiDiagnostics, GithubApiError } from "./api-error";
import {
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	HTTP_OK,
	HTTP_PAYLOAD_TOO_LARGE,
	HTTP_UNAUTHORIZED,
} from "./http-status";
import type { CommitProblem } from "./commits";
import type { PrStateProblem } from "./decision";

/**
 * The half of the vocabulary a delivery skips with: an evaluation that completed
 * and did not approve. The §3 rows are one per condition, named by what that
 * condition can actually return, so a renamed problem there is a compile error
 * here rather than a silent change to the logged vocabulary. The rest are
 * outcomes of the pipeline itself.
 */
type SkipReason =
	| CommitProblem
	| PrStateProblem
	| "already-approved"
	| "author-not-trusted"
	| "event-out-of-scope"
	| "head-moved"
	| "review-rejected";
/** The other half: an evaluation that could not be completed, which the §9 status table below keys. */
type ErrorReason =
	| "github-api-error"
	| "internal-error"
	| "invalid-payload"
	| "invalid-signature"
	| "missing-installation"
	| "missing-webhook-secret"
	| "not-found"
	| "payload-too-large";
/**
 * SPEC.md §8's reason vocabulary, closed rather than illustrative because it is what an operator
 * greps — and stated as the two halves above rather than as one flat union, because §8's table
 * assigns every reason to exactly one decision: flat, a skip could be reported as an error, and the
 * §9 status table below would be keyed by reasons that can never reach it. Reunited here because
 * the logged vocabulary is the whole of both.
 */
type Reason = ErrorReason | SkipReason;

/**
 * Evaluation result mapped onto the §9 status table and the §8 log entry.
 * endpoint, status (0 = network failure) and the ApiDiagnostics group it extends
 * — the header-derived fields a failed call carries — are set for the
 * github-api-error outcome only; errorName (a thrown error's class name) for the
 * internal-error outcome only; errorMessage, part of that group, for either; and
 * field, the dot path of the payload field that failed validation, for the
 * invalid-payload outcome only. Extending Partial<ApiDiagnostics> rather than
 * restating those fields is what makes a diagnostic added there reach this
 * outcome — and, through the entry point's AllOutcomeFieldsLogged check, the §8
 * log entry — instead of riding on the error and being silently dropped here.
 * Partial also keeps them spelled `| undefined` rather than merely optional,
 * which is what §8 asks for: the failure paths set them from a failure that may
 * have carried no response — and, for field, no locatable field — at all, and
 * such a field is to be absent from the entry rather than logged empty.
 */
interface Outcome extends Partial<ApiDiagnostics> {
	readonly decision: "approved" | "error" | "skipped";
	readonly endpoint?: string;
	readonly errorName?: string;
	readonly field?: string | undefined;
	readonly httpStatus: number;
	readonly reason?: Reason;
	readonly status?: number;
}
/** The §8 fields an error outcome carries beyond its reason; see Outcome for which outcome sets which. */
type ErrorDetail = Omit<Outcome, "decision" | "httpStatus" | "reason">;

/** SPEC.md §4 step 8: the approval landed, which is the one outcome with nothing further to report. */
function approvedOutcome(): Outcome {
	return { decision: "approved", httpStatus: HTTP_OK };
}
function skippedOutcome(reason: SkipReason): Outcome {
	return { decision: "skipped", httpStatus: HTTP_OK, reason };
}
/**
 * SPEC.md §9's status table for the failures, as data rather than as an argument each construction
 * site passes: the three the request itself settles, and 5xx below for everything else. A non-2xx
 * is what marks an evaluation that could not be completed — loud in Recent Deliveries and
 * redeliverable — so a reason added to the vocabulary with no entry here answers 500 by the rule
 * §9 states, rather than by whichever caller remembered to pass a status.
 */
const ERROR_STATUS: Partial<Record<ErrorReason, number>> = {
	"invalid-signature": HTTP_UNAUTHORIZED,
	"not-found": HTTP_NOT_FOUND,
	"payload-too-large": HTTP_PAYLOAD_TOO_LARGE,
};
/* The one way an error outcome is built, whichever §8 fields it carries: the reason decides the
 * status, and the detail is merged onto it with Object.assign rather than spread (the spread
 * properties are lint-banned), so what every failure has in common is stated once. */
function errorOutcome(reason: ErrorReason, detail: ErrorDetail = {}): Outcome {
	const failure: Outcome = {
		decision: "error",
		httpStatus: ERROR_STATUS[reason] ?? HTTP_INTERNAL_ERROR,
		reason,
	};
	return Object.assign(failure, detail);
}
/* SPEC.md §9: keep status and endpoint so 401/403 configuration problems are distinguishable in
 * logs, and the §8 diagnostics with them — status alone does not say whether a 403 was a missing
 * permission or a rate limit, which is the distinction §9 asks for. They are absent when the
 * failure carried no response to read them from. Carried as the whole diagnostics group rather
 * than field by field, so a diagnostic added to it reaches the outcome here. Mapped alongside the
 * error contract it reads (src/api-error.ts) rather than restated by whoever catches the error. */
function apiErrorOutcome(error: GithubApiError): Outcome {
	const origin = { endpoint: error.endpoint, status: error.status };
	return errorOutcome("github-api-error", Object.assign(origin, error.diagnostics));
}
/* SPEC.md §9's "any other thrown failure", mapped beside the failure the pipeline maps above so
 * every thrown value becomes its outcome in this one module: the class name keeps configuration
 * mistakes (e.g. a PKCS#1 key the auth library rejects) distinguishable from code bugs, and §8's
 * errorMessage — truncated where the log entry is built (src/log.ts) — is what says which mistake
 * it was, the class alone being `Error` for both. A value thrown that is not an Error has no
 * message to report — the class name already says so — so the field is left off rather than
 * filled with a stringification of whatever it was. */
function internalErrorOutcome(error: unknown): Outcome {
	if (error instanceof Error) {
		return errorOutcome("internal-error", { errorMessage: error.message, errorName: error.name });
	}
	return errorOutcome("internal-error", { errorName: "unknown" });
}

export { apiErrorOutcome, approvedOutcome, errorOutcome, internalErrorOutcome, skippedOutcome };
export type { ErrorReason, Outcome, Reason, SkipReason };
