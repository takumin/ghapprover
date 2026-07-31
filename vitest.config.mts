import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

declare global {
	/**
	 * Both Node and Vite provide `import.meta.url`, but the lib set this project
	 * typechecks against is the Workers one, which does not declare it.
	 */
	interface ImportMeta {
		url: string;
	}
}

/**
 * Where `~src` points at runtime. The same mapping is declared for the
 * typechecker as tsconfig.json's `paths`, and the two have to agree.
 */
const srcDir = new URL("src", import.meta.url).pathname;

// oxlint-disable-next-line import/no-default-export -- vitest takes its config as the module's default export
export default defineConfig({
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
		}),
	],
	resolve: {
		alias: { "~src": srcDir },
	},
});
