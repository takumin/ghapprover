/**
 * The HTTP statuses this Worker names, stated once: the §9 statuses a delivery answers with
 * (src/outcome.ts) and the ones a GitHub call is guarded on (src/github.ts) overlap, and
 * `no-magic-numbers` forces a named constant at every use site — so a status declared per module
 * is one that can be given a different name, or a different number, in each of them.
 */

const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const HTTP_NOT_FOUND = 404;
const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_UNPROCESSABLE_ENTITY = 422;
const HTTP_INTERNAL_ERROR = 500;

export {
	HTTP_INTERNAL_ERROR,
	HTTP_NOT_FOUND,
	HTTP_OK,
	HTTP_PAYLOAD_TOO_LARGE,
	HTTP_UNAUTHORIZED,
	HTTP_UNPROCESSABLE_ENTITY,
};
