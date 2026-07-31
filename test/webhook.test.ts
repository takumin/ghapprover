import { describe, expect, it } from "vitest";
import { sign } from "@octokit/webhooks-methods";
import { verifyWebhookSignature } from "../src/webhook";

/** The frozen signature accepts string | null for the missing-header case. */
const NO_HEADER = null;

const SECRET = "test-webhook-secret";
const BODY = '{"action":"opened","number":1}';
const SHA256_PREFIX = "sha256=";
/** Named booleans satisfy both boolean-matcher style rules at once. */
const VALID = true;
const INVALID = false;

/* Headers are produced by the same package's sign() — the counterpart of the verify() under
 * test, and an independent function from it, so this asserts against the real GitHub format
 * rather than against a second HMAC implementation maintained here. The malformed cases below
 * rebuild the header from this digest; the well-formed ones use sign()'s own output as-is. */
async function signHex(secret: string, body: string): Promise<string> {
	const header = await sign(secret, body);
	return header.slice(SHA256_PREFIX.length);
}

describe("verifyWebhookSignature acceptance", () => {
	it("accepts a valid sha256 signature", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const header = await sign(SECRET, BODY);
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(VALID);
	});

	it("accepts uppercase hex digests", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const hex = await signHex(SECRET, BODY);
		const header = `${SHA256_PREFIX}${hex.toUpperCase()}`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(VALID);
	});
});

describe("verifyWebhookSignature rejection", () => {
	it("rejects a signature over a tampered body", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const header = await sign(SECRET, BODY);
		await expect(verifyWebhookSignature(SECRET, '{"action":"closed"}', header)).resolves.toBe(
			INVALID,
		);
	});

	it("rejects a signature made with the wrong secret", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const header = await sign("other-secret", BODY);
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(INVALID);
	});

	it("rejects a missing header", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		await expect(verifyWebhookSignature(SECRET, BODY, NO_HEADER)).resolves.toBe(INVALID);
	});

	it("rejects a sha1 header", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const header = `sha1=${await signHex(SECRET, BODY)}`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(INVALID);
	});

	it("rejects truncated hex", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const hex = await signHex(SECRET, BODY);
		const header = `${SHA256_PREFIX}${hex.slice(1)}`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(INVALID);
	});

	it("rejects non-hex characters", { timeout: 5000 }, async () => {
		expect.hasAssertions();
		const hex = await signHex(SECRET, BODY);
		const header = `${SHA256_PREFIX}${hex.slice(0, -1)}z`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(INVALID);
	});
});
