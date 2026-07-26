export default {
	async fetch(_request: Request, _env: Env, _ctx: ExecutionContext): Promise<Response> {
		return new Response("OK");
	},
} satisfies ExportedHandler<Env>;
