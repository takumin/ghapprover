#!/bin/sh
#
# Comments here navigate by naming other files -- "see src/pipeline.ts", "shared
# with test/github-api.ts" -- and a rename leaves those names pointing at
# nothing. This reports every mention of a src/*.ts, test/*.ts or scripts/*.sh
# path that no longer resolves, as `file:line:col: message` for reviewdog.
#
# Deliberately limited to file paths: SPEC.md section numbers are not checked,
# because a stale section number still lands the reader near the right place.

set -eu

cd "$(git rev-parse --show-toplevel)"

# Spelled as an alternation, and with `[.]` rather than `\.`, so that this line
# does not match the pattern it defines: `src` here is followed by `|` and
# `scripts/` by `[`, neither of which a real path can be.
pattern='(src|test)/[0-9A-Za-z._-]+[.]ts|scripts/[0-9A-Za-z._-]+[.]sh'

# `git grep` supplies the file set (tracked files only) and skips binaries with
# -I, so lock files and generated blobs never reach awk. awk then walks each
# reported line for every occurrence, since one line can name several files.
git grep --no-color -I -n -E -e "${pattern}" \
	| awk -v pattern="${pattern}" '
		function resolves(path,   ignored, status) {
			if (!(path in cache)) {
				# getline returns -1 when the file cannot be opened, and 0 at
				# end of file -- so an existing but empty file still resolves.
				status = (getline ignored < path)
				close(path)
				cache[path] = (status >= 0)
			}
			return cache[path]
		}
		{
			# `git grep -n` prints file:line:text, and the text is whatever the
			# line holds, colons included -- so split on the first two only.
			cut = index($0, ":")
			file = substr($0, 1, cut - 1)
			rest = substr($0, cut + 1)
			cut = index(rest, ":")
			lineno = substr(rest, 1, cut - 1)
			text = substr(rest, cut + 1)

			consumed = 0
			while (match(text, pattern)) {
				path = substr(text, RSTART, RLENGTH)
				if (!resolves(path)) {
					printf "%s:%s:%d: reference to missing file %s\n", \
						file, lineno, consumed + RSTART, path
					dangling = 1
				}
				consumed += RSTART + RLENGTH - 1
				text = substr(text, RSTART + RLENGTH)
			}
		}
		END {
			if (dangling) {
				exit 1
			}
		}
	'
