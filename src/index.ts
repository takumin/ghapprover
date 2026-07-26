export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return new Response("OK");
	},
} satisfies ExportedHandler<Env>;
