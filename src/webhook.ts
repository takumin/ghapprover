/**
 * X-Hub-Signature-256 webhook verification (SPEC.md §7, §11): the HMAC
 * computation and comparison are delegated to @octokit/webhooks-methods'
 * verify(), which is Web Crypto based and timing-safe. Only the header-shape
 * guard lives here, because verify() throws on empty or malformed input while
 * the handler needs a plain boolean.
 */

import { verify } from "@octokit/webhooks-methods";

/** "sha256=" followed by exactly the 64 hex chars of an HMAC-SHA256 digest. */
const SIGNATURE_PATTERN = /^sha256=[0-9a-f]{64}$/iu;

/**
 * Verifies a "sha256=<64 hex chars>" signature header (upper- or lowercase
 * hex) against the raw body. A null or malformed header is rejected before
 * any crypto work. Never throws: verification failures of any kind yield
 * false, which the handler maps to 401 (SPEC.md §9).
 */
export async function verifyWebhookSignature(
	secret: string,
	body: string,
	signatureHeader: string | null,
): Promise<boolean> {
	if (signatureHeader === null || !SIGNATURE_PATTERN.test(signatureHeader)) {
		return false;
	}
	try {
		return await verify(secret, body, signatureHeader);
	} catch {
		return false;
	}
}
