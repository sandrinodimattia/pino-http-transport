# Contributing

Use Node.js 24 and pnpm 11. Before opening a pull request, run:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test:coverage
npm pack --dry-run --json
```

Keep changes focused and add regression tests for behavior changes. Biome owns
formatting and linting; TypeScript is checked with strict compiler options.
Keep transport tests in `test/`, including worker and package-loading coverage
where relevant.

Document exported declarations and meaningful internal helpers with concise
JSDoc. Describe behavior and invariants rather than restating TypeScript types.
The package is ESM-only and supports Node.js 24 or later.

Write concise commit subjects that explain the user-visible change. Releases
are created from `main` with `release-it`; GitHub generates the release notes
from commits since the previous tag. Do not edit the version manually.
