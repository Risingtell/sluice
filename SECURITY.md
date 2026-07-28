# Security Policy

Sluice moves real value (testnet and mainnet CEP-18 transfers via Casper
x402). Please report security issues privately rather than as a public
issue.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository
(Security tab -> "Report a vulnerability"), or reach the maintainer directly
at x.com/agentsluice. Please include:

- A description of the issue and its impact (e.g. fund loss, key exposure,
  settlement double-count).
- Steps to reproduce, or the code path involved.
- Whether it affects the self-hosted facilitator, the meter, the verifier,
  or the SDK/MCP client.

We'll acknowledge reports and follow up with a fix or mitigation timeline.

## Scope

In scope: this repository's server, facilitator, meter, verifier, SDK, and
MCP server code. Out of scope: the upstream `@make-software/casper-x402`
package and the Casper network itself — report those to their respective
maintainers.

## Supported versions

This is an actively developed hackathon-stage project on a single branch
(`master`). Only the latest commit is supported; there are no maintained
release branches.
