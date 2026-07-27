/**
 * X-Hub-Signature-256 webhook verification (SPEC.md §7): HMAC-SHA256 over the
 * raw request body. The digest comparison is delegated to crypto.subtle.verify,
 * which is inherently timing-safe — hex digests are never string-compared.
 */

const SIGNATURE_PREFIX = "sha256=";
/** Hex length of an HMAC-SHA256 digest (32 bytes). */
const SIGNATURE_HEX_LENGTH = 64;
const HEX_CHARS_PER_BYTE = 2;
const HEX_RADIX = 16;

const HEX_PATTERN = /^[0-9a-f]+$/iu;

function decodeHex(hex: string): Uint8Array {
	const bytes = new Uint8Array(hex.length / HEX_CHARS_PER_BYTE);
	for (let index = 0; index < bytes.length; index += 1) {
		const offset = index * HEX_CHARS_PER_BYTE;
		bytes[index] = Number.parseInt(hex.slice(offset, offset + HEX_CHARS_PER_BYTE), HEX_RADIX);
	}
	return bytes;
}

/**
 * Verifies a "sha256=<64 hex chars>" signature header (upper- or lowercase hex)
 * against the raw body. A null or malformed header is rejected before any
 * crypto work. Never throws: verification failures of any kind yield false,
 * which the handler maps to 401 (SPEC.md §9).
 */
export async function verifyWebhookSignature(
	secret: string,
	body: string,
	signatureHeader: string | null,
): Promise<boolean> {
	if (signatureHeader === null || !signatureHeader.startsWith(SIGNATURE_PREFIX)) {
		return false;
	}
	const hex = signatureHeader.slice(SIGNATURE_PREFIX.length);
	if (hex.length !== SIGNATURE_HEX_LENGTH || !HEX_PATTERN.test(hex)) {
		return false;
	}
	try {
		const encoder = new TextEncoder();
		const key = await crypto.subtle.importKey(
			"raw",
			encoder.encode(secret),
			{ hash: "SHA-256", name: "HMAC" },
			false,
			["verify"],
		);
		return await crypto.subtle.verify("HMAC", key, decodeHex(hex), encoder.encode(body));
	} catch {
		return false;
	}
}
