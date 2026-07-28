/**
 * Shared App private key fixture: generated once per suite with real Web
 * Crypto and exported as a PKCS#8 PEM, the only format the auth library can
 * import (SPEC.md §7). PEM material is never hard-coded.
 */

const RSA_PARAMS = {
	hash: "SHA-256",
	modulusLength: 2048,
	name: "RSASSA-PKCS1-v1_5",
	publicExponent: new Uint8Array([1, 0, 1]),
};
const PEM_LINE_WIDTH = 64;

function wrapPem(base64: string): string {
	const lines: string[] = [];
	for (let offset = 0; offset < base64.length; offset += PEM_LINE_WIDTH) {
		lines.push(base64.slice(offset, offset + PEM_LINE_WIDTH));
	}
	return `-----BEGIN PRIVATE KEY-----\n${lines.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

async function generatePrivateKeyPem(): Promise<string> {
	const generated = await crypto.subtle.generateKey(RSA_PARAMS, true, ["sign", "verify"]);
	if (!("privateKey" in generated)) {
		throw new Error("expected an RSA key pair");
	}
	const exported = await crypto.subtle.exportKey("pkcs8", generated.privateKey);
	if (!(exported instanceof ArrayBuffer)) {
		throw new Error("expected an ArrayBuffer export");
	}
	const chars = Array.from(new Uint8Array(exported), (byte) => String.fromCodePoint(byte));
	return wrapPem(btoa(chars.join("")));
}

// oxlint-disable-next-line unicorn/no-useless-undefined -- init-declarations requires the initializer
let cached: Promise<string> | undefined = undefined;

/** Generates the PEM once and shares it across tests. */
export async function privateKeyPemOnce(): Promise<string> {
	cached ??= generatePrivateKeyPem();
	return cached;
}
