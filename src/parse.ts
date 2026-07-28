/**
 * Narrowing primitives for untrusted JSON. The webhook body (src/decision.ts)
 * and the REST responses (src/github.ts) both rebuild src/types.ts shapes from
 * `unknown` field-by-field rather than asserting them, and both fail closed on
 * anything that does not match (SPEC.md §9). The rules live here so each
 * contract has one enforcer: a field tightened on the response path cannot
 * leave the payload path looser. `undefined` is the single failure sentinel;
 * callers that also model absence map it onto their own convention.
 */

import type { GithubAccount } from "./types";

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
/** Key-variable accessor so no index-signature property is accessed by name. */
export function field(value: unknown, key: string): unknown {
	if (isRecord(value)) {
		return value[key];
	}
	return undefined;
}
export function stringField(value: unknown, key: string): string | undefined {
	const fieldValue = field(value, key);
	if (typeof fieldValue === "string") {
		return fieldValue;
	}
	return undefined;
}
/** A bare `{ id }` reference (the installation, the head repository); anything else fails closed. */
export function toIdRef(value: unknown): { readonly id: number } | undefined {
	const id = field(value, "id");
	if (typeof id !== "number") {
		return undefined;
	}
	return { id };
}
/** The (id, login, type) triple every §3 trust decision is made against; anything else fails closed. */
export function toAccount(value: unknown): GithubAccount | undefined {
	const id = field(value, "id");
	const login = stringField(value, "login");
	const type = stringField(value, "type");
	if (typeof id !== "number" || login === undefined || type === undefined) {
		return undefined;
	}
	return { id, login, type };
}
