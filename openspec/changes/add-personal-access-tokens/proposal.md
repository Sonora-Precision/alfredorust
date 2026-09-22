# Proposal: Personal access tokens for CLI and skills

## Problem

`spcli` currently stores the user's permanent TOTP seed so it can recreate
browser sessions. That makes onboarding awkward and gives automation a secret
whose purpose is interactive sign-in.

## Change

- Let an authenticated user create, list, and revoke named personal access tokens.
- Show token plaintext exactly once and store only its cryptographic digest.
- Accept tokens through the HTTP Bearer authorization scheme while preserving
  live tenant membership, role, and permission checks.
- Let `spcli` accept a token from standard input or `SPCLI_TOKEN` and stop
  requiring TOTP for new configurations.
- Keep legacy TOTP login temporarily for migration.

## Impact

The change adds one MongoDB collection, three account APIs, account UI, Bearer
authentication in the existing middleware, and a new `spcli auth token` command.
