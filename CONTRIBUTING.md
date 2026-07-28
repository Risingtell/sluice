# Contributing to Sluice

Thanks for taking a look. Sluice is a streaming x402 payment meter for the
agent economy on Casper, currently a hackathon-stage project. Small, focused
contributions are welcome.

## Before you start

- Read `README.md` for the architecture and `JUDGE-QUICKSTART.md` for the
  fastest way to run it end to end.
- Prefer an issue first for anything beyond a small fix, so we can agree on
  direction before you spend time on it.

## Local setup

```bash
npm install
npm run typecheck
npm test
```

`npm run server` (mock mode by default) then `npm run agent` runs the full
streaming loop locally with no on-chain credentials needed. See `README.md`
for how to switch to live testnet or mainnet mode.

## Making a change

1. Fork the repo and create a branch off `master`.
2. Keep the change scoped; avoid unrelated formatting or refactors in the
   same PR.
3. Run `npm run typecheck` and `npm test` before opening the PR — both must
   pass clean.
4. If you touch settlement, meter, or verifier logic, add or update a test
   in `tests/sluice.test.ts` that would fail without your fix.
5. Open a pull request describing what changed and why.

## Reporting bugs or security issues

- Functional bugs: open a GitHub issue with steps to reproduce.
- Security issues (key handling, settlement logic, anything that could move
  funds incorrectly): please see `SECURITY.md` rather than filing a public
  issue.
