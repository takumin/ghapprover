/**
 * The frame every GitHub call is made in (SPEC.md §9, §11): the dispatch that maps whatever a call
 * throws onto GithubApiError, the one tolerated failure a call may answer with instead, and the
 * validation of a response against the schema that models it. Split from the endpoints themselves
 * (src/github.ts) so that module states only what each call sends and reads.
 */

import type { GenericSchema, InferOutput } from "valibot";
import { isFailureOn, shapeError, toApiError } from "./api-error";
import type { EndpointStatus } from "./api-error";
import { HTTP_OK } from "./http-status";
import { safeParse } from "valibot";

/* One response value against the schema that models it. The schema rebuilds the value from the modeled
 * fields alone, so nothing unmodeled travels on from here, and a violation throws as a github-api-error
 * naming the route (SPEC.md §9). The validation issue itself is discarded: §8 gives `field` to
 * invalid-payload alone, where the body is the App's own contract with GitHub, and a response that
 * breaks its shape is already located by the endpoint the error names. */
function parseContract<Schema extends GenericSchema>(
	schema: Schema,
	value: unknown,
	origin: EndpointStatus,
): InferOutput<Schema> {
	const result = safeParse(schema, value);
	if (!result.success) {
		throw shapeError(origin);
	}
	return result.output;
}

/** The one frame every call below is dispatched inside: whatever it throws leaves as the frozen
 * GithubApiError contract, named after the endpoint asked for (SPEC.md §9, §11). Owned here rather
 * than restated per endpoint, because a call that skipped the mapping would reach the entry point as
 * an internal-error and drop the §8 diagnostics the failed call carries — which compiles, and still
 * works, so nothing else would say so. The dispatch is passed in rather than the route, so each
 * endpoint keeps octokit's own checking of the parameters that route takes. */
async function dispatched<Result>(endpoint: string, call: () => Promise<Result>): Promise<Result> {
	try {
		return await call();
	} catch (error) {
		throw toApiError(endpoint, error);
	}
}
/** A call whose one documented failure is an answer rather than an error (SPEC.md §9): a 404 from the
 * membership lookup means "not a member", a 422 from the review POST means the pull request closed
 * underneath it. Stated once, so the two read alike and neither can drift into swallowing more than
 * the one status it is entitled to. Matched on the endpoint as well as the status (src/api-error.ts):
 * the auth strategy issues its token request from inside these very calls, and absorbing its 404 here
 * would turn a configuration failure into a routine skip. */
async function answering<Answer, Result>(
	tolerated: EndpointStatus,
	answer: Answer,
	call: () => Promise<Result>,
): Promise<Answer | Result> {
	try {
		return await call();
	} catch (error) {
		if (isFailureOn(error, tolerated)) {
			return answer;
		}
		throw error;
	}
}
/** A response and the schema that models it, through the frame above: the two halves every non-paginated call is made of. */
async function contractCall<Schema extends GenericSchema>(
	endpoint: string,
	call: () => Promise<{ readonly data: unknown; readonly status: number }>,
	schema: Schema,
): Promise<InferOutput<Schema>> {
	const response = await dispatched(endpoint, call);
	return parseContract(schema, response.data, { endpoint, status: response.status });
}

/** Paginated items through the frame above, each validated against the schema that models it. Item
 * shape errors surface after a successful page, so they carry 200; the item is taken as `unknown`
 * rather than as the shape octokit types it, which nothing here has checked yet. */
async function contractItems<Schema extends GenericSchema>(
	endpoint: string,
	call: () => Promise<readonly unknown[]>,
	itemSchema: Schema,
): Promise<readonly InferOutput<Schema>[]> {
	const items = await dispatched(endpoint, call);
	const origin = { endpoint, status: HTTP_OK };
	return items.map((item: unknown) => parseContract(itemSchema, item, origin));
}

export { answering, contractCall, contractItems, dispatched };
