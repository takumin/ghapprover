import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/webhook";

/** The frozen signature accepts string | null for the missing-header case. */
// oxlint-disable-next-line unicorn/no-null -- single sanctioned null literal for the contract above
const NO_HEADER = null;

const SECRET = "test-webhook-secret";
const BODY = '{"action":"opened","number":1}';
const HEX_RADIX = 16;
const HEX_PAD = 2;
/** Named booleans satisfy both boolean-matcher style rules at once. */
const VALID = true;
const INVALID = false;

/** Computes the expected HMAC-SHA256 hex digest with real Web Crypto. */
async function signHex(secret: string, body: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(secret),
		{ hash: "SHA-256", name: "HMAC" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
	return Array.from(new Uint8Array(signature), (byte) =>
		byte.toString(HEX_RADIX).padStart(HEX_PAD, "0"),
	).join("");
}

describe("verifyWebhookSignature acceptance", () => {
	it("accepts a valid sha256 signature", async () => {
		expect.hasAssertions();
		const header = `sha256=${await signHex(SECRET, BODY)}`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(VALID);
	});

	it("accepts uppercase hex digests", async () => {
		expect.hasAssertions();
		const hex = await signHex(SECRET, BODY);
		const header = `sha256=${hex.toUpperCase()}`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(VALID);
	});
});

describe("verifyWebhookSignature rejection", () => {
	it("rejects a signature over a tampered body", async () => {
		expect.hasAssertions();
		const header = `sha256=${await signHex(SECRET, BODY)}`;
		await expect(verifyWebhookSignature(SECRET, '{"action":"closed"}', header)).resolves.toBe(
			INVALID,
		);
	});

	it("rejects a signature made with the wrong secret", async () => {
		expect.hasAssertions();
		const header = `sha256=${await signHex("other-secret", BODY)}`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(INVALID);
	});

	it("rejects a missing header", async () => {
		expect.hasAssertions();
		await expect(verifyWebhookSignature(SECRET, BODY, NO_HEADER)).resolves.toBe(INVALID);
	});

	it("rejects a sha1 header", async () => {
		expect.hasAssertions();
		const header = `sha1=${await signHex(SECRET, BODY)}`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(INVALID);
	});

	it("rejects truncated hex", async () => {
		expect.hasAssertions();
		const hex = await signHex(SECRET, BODY);
		const header = `sha256=${hex.slice(1)}`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(INVALID);
	});

	it("rejects non-hex characters", async () => {
		expect.hasAssertions();
		const hex = await signHex(SECRET, BODY);
		const header = `sha256=${hex.slice(0, -1)}z`;
		await expect(verifyWebhookSignature(SECRET, BODY, header)).resolves.toBe(INVALID);
	});
});
