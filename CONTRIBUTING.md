# Contributing

## Branches

| Branch | Purpose | Protected |
|---|---|---|
| `main` | Demo/production-ready. Only merges from `develop` (or `hotfix/*`) via PR. | Yes |
| `develop` | Integration branch. Only merges from `feature/*` via PR. | Yes |
| `feature/<name>` | One branch per task, cut from `develop`. | No |

Flow: `feature/<name>` → PR → `develop` → PR → `main`.

## Commit messages — Conventional Commits

```
<type>(<scope>): <subject>
```

Types: `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore`, `revert`.

Examples:
```
feat(orders): add Lua script for atomic stock claim
fix(products): clamp limit param to 100
docs(readme): add local dev instructions
```

Enforced two ways:
- **Locally**: husky `commit-msg` hook runs commitlint before the commit is created. Run `npm install` once at repo root to activate it.
- **CI**: `.github/workflows/ci.yml` lints every commit in a PR. Auto-generated merge commits ("Merge pull request #123 from ...") are skipped automatically — no need to force-format those.

## Branch protection (set once, in GitHub repo settings — no CLI available to script this)

Settings → Branches → Add rule, for both `main` and `develop`:

- Require a pull request before merging (require ≥1 approval)
- Require status checks to pass before merging → select the `commitlint` and `backend` checks from the `CI` workflow
- Include administrators (optional, but keeps everyone honest)

This blocks direct `git push` to `main`/`develop` — all changes land through a reviewed PR.
