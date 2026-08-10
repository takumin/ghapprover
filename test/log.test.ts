/**
 * The severity SPEC.md §8's entry carries: the `level` field Workers Logs files it under, and the
 * console method it is emitted through. Driven off the table itself (src/log.ts) rather than off a
 * list restated here, so a reason added to the vocabulary is covered by this suite the moment the
 * table has to name it — what is asserted is that both halves of the severity agree and that
 * neither is left off, which is the failure the field exists to prevent: an entry filed with no
 * severity at all reads, in the dashboard's Level column, exactly like one nothing went wrong for.
 */

import type { LogFields, LogLevel } from "~src/log";
import type { Outcome, Reason } from "~src/outcome";
import { REASON_LEVEL, logOutcome } from "~src/log";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { HTTP_OK } from "~src/http-status";
import type { MockInstance } from "vitest";
import { approvedOutcome } from "~src/outcome";

/* Every console method a Worker has, and not only the three the table can name: what says the
 * severity reached the sink is that the other methods stayed silent, and `log` — the one method
 * every entry used before the severity existed — is the one it would regress onto. */
const SINKS = ["debug", "error", "info", "log", "warn"] as const;
type Sink = (typeof SINKS)[number];

/* Silenced rather than merely observed: this suite emits an entry per reason in the vocabulary,
 * and a run that printed each of them would bury whatever the failure was. */
function spyOnSink(sink: Sink): MockInstance<typeof console.log> {
	const spy = vi.spyOn(console, sink).mockImplementation(vi.fn<typeof console.log>());
	onTestFinished(() => {
		spy.mockRestore();
	});
	return spy;
}
function captureSinks(): Record<Sink, MockInstance<typeof console.log>> {
	return {
		debug: spyOnSink("debug"),
		error: spyOnSink("error"),
		info: spyOnSink("info"),
		log: spyOnSink("log"),
		warn: spyOnSink("warn"),
	};
}

/* The severity is decided by the reason alone (src/log.ts), so the decision the outcome announces
 * is not what these cases vary — stating it as the skip keeps every row buildable from the table's
 * key, where splitting the vocabulary back into its two halves would only restate src/outcome.ts. */
function outcomeFor(reason: Reason): Outcome {
	return { decision: "skipped", httpStatus: HTTP_OK, reason };
}
/* Object.entries widens the key to `string`, and the table is exactly the vocabulary: the
 * assertion narrows it back to what the table's own type already states. */
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the widening above is Object.entries', not this table's
const VOCABULARY = Object.entries(REASON_LEVEL) as readonly (readonly [Reason, LogLevel])[];

describe("entry severity", () => {
	it.each(VOCABULARY)("files %s at %s", { timeout: 5000 }, (reason, level) => {
		expect.hasAssertions();
		const sinks = captureSinks();
		const log: LogFields = {};
		logOutcome(log, outcomeFor(reason));
		expect(log["level"]).toBe(level);
		/* The entry as it was emitted, not a copy: the field has to be on what reached the sink,
		 * a `level` set after the emit being a field no destination ever sees. */
		expect(sinks[level]).toHaveBeenCalledExactlyOnceWith(log);
		/* The sinks that received an entry, as the whole of what was called rather than one method
		 * at a time: what says the severity reached its own sink is that the others stayed silent. */
		expect(SINKS.filter((sink) => sinks[sink].mock.calls.length > 0)).toStrictEqual([level]);
	});

	/* SPEC.md §8: an approval carries no reason, so it is the one outcome the table above cannot
	 * key — and the one whose severity a rule derived from `reason` alone would leave unset. */
	it("files an approval at info", { timeout: 5000 }, () => {
		expect.hasAssertions();
		const sinks = captureSinks();
		const log: LogFields = {};
		logOutcome(log, approvedOutcome());
		expect(log["level"]).toBe("info");
		expect(sinks.info).toHaveBeenCalledExactlyOnceWith(log);
		expect(SINKS.filter((sink) => sinks[sink].mock.calls.length > 0)).toStrictEqual(["info"]);
	});
});
