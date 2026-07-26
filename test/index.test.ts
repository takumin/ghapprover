import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { env } from "cloudflare:workers";
import worker from "../src/index";

describe("fetch handler", () => {
	it("responds with OK", async () => {
		expect.hasAssertions();
		const request = new Request("http://example.com/");
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);
		await expect(response.text()).resolves.toBe("OK");
	});
});
