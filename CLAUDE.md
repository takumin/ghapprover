# CLAUDE.md

## Commit Messages

Write commit messages in English, following
[Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

- Use the imperative mood and lowercase for `<description>`, with no trailing period.
- Keep the subject line within 72 characters.
- Wrap the body at 72 characters and explain _why_ the change is made, not _what_
  changed.
- For a breaking change, append `!` after the type/scope (e.g. `feat!:`) and add a
  `BREAKING CHANGE:` footer describing the migration path.

### Types

| Type       | Use for                                                                        |
| ---------- | ------------------------------------------------------------------------------ |
| `feat`     | A new user-facing capability                                                   |
| `fix`      | A bug fix                                                                      |
| `docs`     | Documentation only (e.g. `SPEC.md`, `README.md`)                               |
| `refactor` | A code change that neither fixes a bug nor adds a feature                      |
| `perf`     | A performance improvement                                                      |
| `test`     | Adding or correcting tests                                                     |
| `build`    | Build system, dependencies, or tooling (`package.json`, mise, wrangler config) |
| `ci`       | CI configuration and automation (GitHub Actions, Renovate)                     |
| `chore`    | Maintenance that fits no other type                                            |
| `revert`   | Reverting a previous commit                                                    |

Pull request titles follow the same convention, and PR descriptions are written in
English.
