/**
 * GitHub App JWT signing (SPEC.md §7): RS256 via Web Crypto. The private key
 * PEM is accepted both as PKCS#8 ("BEGIN PRIVATE KEY") and as the PKCS#1
 * format GitHub serves for download ("BEGIN RSA PRIVATE KEY"), the latter by
 * wrapping the PKCS#1 DER in a PKCS#8 envelope before import.
 */

const MS_PER_SECOND = 1000;
/** GitHub caps App JWTs at 10 minutes; exp lands at now + 540s, under the cap. */
const JWT_TTL_SECONDS = 600;
/** Backdating iat tolerates clock drift between this Worker and GitHub. */
const CLOCK_DRIFT_SECONDS = 60;

const PEM_BEGIN_PREFIX = "-----BEGIN ";
const PEM_BOUNDARY = "-----";
const PKCS8_LABEL = "PRIVATE KEY";
const PKCS1_LABEL = "RSA PRIVATE KEY";

const DER_SEQUENCE_TAG = 0x30;
const DER_INTEGER_TAG = 0x02;
const DER_OCTET_STRING_TAG = 0x04;
/** A first length byte at or above this marks a multi-byte (long form) length. */
const DER_LONG_FORM_FLAG = 0x80;
const BYTE_BASE = 256;

function decodeBase64(base64: string): Uint8Array {
	return Uint8Array.from(atob(base64), (char) => char.codePointAt(0) ?? 0);
}

/** AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1 (rsaEncryption), NULL }. */
const RSA_ALGORITHM_IDENTIFIER = decodeBase64("MA0GCSqGSIb3DQEBAQUA");

const RSA_IMPORT_ALGORITHM = { hash: "SHA-256", name: "RSASSA-PKCS1-v1_5" };

function base64UrlEncodeBytes(bytes: Uint8Array): string {
	const binary = Array.from(bytes, (byte) => String.fromCodePoint(byte)).join("");
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlEncodeText(text: string): string {
	return base64UrlEncodeBytes(new TextEncoder().encode(text));
}

interface PemBlock {
	readonly der: Uint8Array;
	readonly label: string;
}

function decodePem(pem: string): PemBlock {
	const lines = pem
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const header = lines.at(0);
	const footer = lines.at(-1);
	if (
		header === undefined ||
		footer === undefined ||
		!header.startsWith(PEM_BEGIN_PREFIX) ||
		!header.endsWith(PEM_BOUNDARY)
	) {
		throw new Error("malformed PEM: missing BEGIN boundary");
	}
	const label = header.slice(PEM_BEGIN_PREFIX.length, header.length - PEM_BOUNDARY.length);
	if (footer !== `-----END ${label}-----`) {
		throw new Error("malformed PEM: missing matching END boundary");
	}
	return { der: decodeBase64(lines.slice(1, -1).join("")), label };
}

/** Definite-length DER encoding: long form once the length exceeds 127. */
function encodeDerLength(length: number): number[] {
	if (length < DER_LONG_FORM_FLAG) {
		return [length];
	}
	const bytes: number[] = [];
	let remaining = length;
	while (remaining > 0) {
		bytes.unshift(remaining % BYTE_BASE);
		remaining = Math.floor(remaining / BYTE_BASE);
	}
	return [DER_LONG_FORM_FLAG + bytes.length, ...bytes];
}

/**
 * PKCS#8 envelope: SEQUENCE { INTEGER 0, AlgorithmIdentifier,
 * OCTET STRING { <pkcs1 der> } }.
 */
function wrapPkcs1InPkcs8(pkcs1: Uint8Array): Uint8Array {
	const version = [DER_INTEGER_TAG, 1, 0];
	const octetString = [DER_OCTET_STRING_TAG, ...encodeDerLength(pkcs1.length), ...pkcs1];
	const content = [...version, ...RSA_ALGORITHM_IDENTIFIER, ...octetString];
	return Uint8Array.from([DER_SEQUENCE_TAG, ...encodeDerLength(content.length), ...content]);
}

function toPkcs8Der(block: PemBlock): Uint8Array {
	if (block.label === PKCS8_LABEL) {
		return block.der;
	}
	if (block.label === PKCS1_LABEL) {
		return wrapPkcs1InPkcs8(block.der);
	}
	throw new Error(`unsupported PEM label: ${block.label}`);
}

async function importRsaPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
	const pkcs8 = toPkcs8Der(decodePem(privateKeyPem));
	return crypto.subtle.importKey("pkcs8", pkcs8, RSA_IMPORT_ALGORITHM, false, ["sign"]);
}

/**
 * Creates the RS256-signed GitHub App JWT with claims
 * { exp: iat + 600, iat: nowSec - 60, iss: appId } and header
 * { alg: "RS256", typ: "JWT" }, base64url-encoded without padding.
 */
export async function createAppJwt(
	appId: string,
	privateKeyPem: string,
	nowMs: number,
): Promise<string> {
	const nowSec = Math.floor(nowMs / MS_PER_SECOND);
	const iat = nowSec - CLOCK_DRIFT_SECONDS;
	const header = { alg: "RS256", typ: "JWT" };
	const claims = { exp: iat + JWT_TTL_SECONDS, iat, iss: appId };
	const signingInput = `${base64UrlEncodeText(JSON.stringify(header))}.${base64UrlEncodeText(
		JSON.stringify(claims),
	)}`;
	const key = await importRsaPrivateKey(privateKeyPem);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(signingInput),
	);
	return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}
