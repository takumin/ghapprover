import { describe, expect, it } from "vitest";
import { createAppJwt } from "../src/jwt";

const APP_ID = "12345";
/** Fixed clock with non-zero milliseconds to prove flooring to whole seconds. */
const NOW_MS = 1_753_600_000_123;
const EXPECTED_IAT = 1_753_599_940;
const EXPECTED_EXP = 1_753_600_540;
const JWT_SEGMENT_COUNT = 3;
const PEM_LINE_WIDTH = 64;
const BASE64_BLOCK = 4;
const BYTE_BASE = 256;
/** DER long-form length marker (first length byte of multi-byte lengths). */
const DER_LONG_FORM = 0x80;
/** A 2048-bit PKCS#1 DER is longer than this, forcing multi-byte DER lengths. */
const MULTI_BYTE_LENGTH_MIN = 255;
/** A named boolean satisfies both boolean-matcher style rules at once. */
const SIGNATURE_OK = true;

const RSA_PARAMS = {
	hash: "SHA-256",
	modulusLength: 2048,
	name: "RSASSA-PKCS1-v1_5",
	publicExponent: new Uint8Array([1, 0, 1]),
};

async function generateRsaKeyPair(): Promise<CryptoKeyPair> {
	const generated = await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"]);
	if (!("privateKey" in generated)) {
		throw new Error("expected an RSA key pair");
	}
	return generated;
}

async function exportPkcs8(privateKey: CryptoKey): Promise<Uint8Array> {
	const exported = await crypto.subtle.exportKey("pkcs8", privateKey);
	if (!(exported instanceof ArrayBuffer)) {
		throw new Error("expected an ArrayBuffer export");
	}
	return new Uint8Array(exported);
}

function toPem(label: string, bytes: Uint8Array): string {
	const base64 = btoa(Array.from(bytes, (byte) => String.fromCodePoint(byte)).join(""));
	const lines: string[] = [];
	for (let offset = 0; offset < base64.length; offset += PEM_LINE_WIDTH) {
		lines.push(base64.slice(offset, offset + PEM_LINE_WIDTH));
	}
	return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function base64UrlDecode(segment: string): Uint8Array {
	const padded = segment.replaceAll("-", "+").replaceAll("_", "/");
	const padding = "=".repeat((BASE64_BLOCK - (padded.length % BASE64_BLOCK)) % BASE64_BLOCK);
	return Uint8Array.from(atob(`${padded}${padding}`), (char) => char.codePointAt(0) ?? 0);
}

function decodeSegment(segment: string): unknown {
	const parsed: unknown = JSON.parse(new TextDecoder().decode(base64UrlDecode(segment)));
	return parsed;
}

interface DerSpan {
	readonly contentStart: number;
	readonly length: number;
}

function readDerLength(bytes: Uint8Array, lengthOffset: number): DerSpan {
	const first = bytes[lengthOffset];
	if (first === undefined) {
		throw new Error("truncated DER");
	}
	if (first < DER_LONG_FORM) {
		return { contentStart: lengthOffset + 1, length: first };
	}
	const byteCount = first - DER_LONG_FORM;
	let length = 0;
	for (let index = 0; index < byteCount; index += 1) {
		length = length * BYTE_BASE + (bytes[lengthOffset + 1 + index] ?? 0);
	}
	return { contentStart: lengthOffset + 1 + byteCount, length };
}

/**
 * Walks the PKCS#8 ASN.1 (outer SEQUENCE, INTEGER version, AlgorithmIdentifier
 * SEQUENCE) and returns the OCTET STRING contents: the PKCS#1 DER.
 */
function extractPkcs1(pkcs8: Uint8Array): Uint8Array {
	const outer = readDerLength(pkcs8, 1);
	const version = readDerLength(pkcs8, outer.contentStart + 1);
	const algorithm = readDerLength(pkcs8, version.contentStart + version.length + 1);
	const octet = readDerLength(pkcs8, algorithm.contentStart + algorithm.length + 1);
	return pkcs8.slice(octet.contentStart, octet.contentStart + octet.length);
}

interface SignedJwt {
	readonly claims: unknown;
	readonly header: unknown;
	readonly segments: readonly string[];
	readonly signatureValid: boolean;
}

async function signWith(label: string, der: Uint8Array, publicKey: CryptoKey): Promise<SignedJwt> {
	const token = await createAppJwt(APP_ID, toPem(label, der), NOW_MS);
	const segments = token.split(".");
	const [headerSegment, claimsSegment, signatureSegment] = segments;
	if (
		headerSegment === undefined ||
		claimsSegment === undefined ||
		signatureSegment === undefined
	) {
		throw new Error("expected three JWT segments");
	}
	const signatureValid = await crypto.subtle.verify(
		"RSASSA-PKCS1-v1_5",
		publicKey,
		base64UrlDecode(signatureSegment),
		new TextEncoder().encode(`${headerSegment}.${claimsSegment}`),
	);
	return {
		claims: decodeSegment(claimsSegment),
		header: decodeSegment(headerSegment),
		segments,
		signatureValid,
	};
}

describe("createAppJwt key formats", () => {
	it("signs a verifiable RS256 JWT from a PKCS#8 PEM", async () => {
		expect.hasAssertions();
		const { privateKey, publicKey } = await generateRsaKeyPair();
		const result = await signWith("PRIVATE KEY", await exportPkcs8(privateKey), publicKey);
		expect(result.segments).toHaveLength(JWT_SEGMENT_COUNT);
		expect(result.header).toStrictEqual({ alg: "RS256", typ: "JWT" });
		expect(result.claims).toStrictEqual({ exp: EXPECTED_EXP, iat: EXPECTED_IAT, iss: APP_ID });
		expect(result.signatureValid).toBe(SIGNATURE_OK);
	});

	it("accepts the PKCS#1 RSA PRIVATE KEY format GitHub serves", async () => {
		expect.hasAssertions();
		const { privateKey, publicKey } = await generateRsaKeyPair();
		const pkcs1 = extractPkcs1(await exportPkcs8(privateKey));
		expect(pkcs1.length).toBeGreaterThan(MULTI_BYTE_LENGTH_MIN);
		const result = await signWith("RSA PRIVATE KEY", pkcs1, publicKey);
		expect(result.header).toStrictEqual({ alg: "RS256", typ: "JWT" });
		expect(result.claims).toStrictEqual({ exp: EXPECTED_EXP, iat: EXPECTED_IAT, iss: APP_ID });
		expect(result.signatureValid).toBe(SIGNATURE_OK);
	});
});

describe("createAppJwt rejection", () => {
	it("rejects an unsupported PEM label", async () => {
		expect.hasAssertions();
		const pem = "-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----";
		await expect(createAppJwt(APP_ID, pem, NOW_MS)).rejects.toThrow("unsupported PEM label");
	});

	it("rejects garbage base64 content", async () => {
		expect.hasAssertions();
		const pem = "-----BEGIN PRIVATE KEY-----\n!!!not-base64!!!\n-----END PRIVATE KEY-----";
		await expect(createAppJwt(APP_ID, pem, NOW_MS)).rejects.toBeInstanceOf(Error);
	});

	it("rejects text without PEM boundaries", async () => {
		expect.hasAssertions();
		await expect(createAppJwt(APP_ID, "not a pem at all", NOW_MS)).rejects.toThrow("malformed PEM");
	});
});
