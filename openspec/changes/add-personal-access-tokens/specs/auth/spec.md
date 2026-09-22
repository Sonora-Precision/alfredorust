# Authentication requirements

## Personal token lifecycle

The system SHALL allow an authenticated browser user to create named personal
access tokens with a bounded expiration. The plaintext token SHALL be returned
only by the create response and SHALL NOT be persisted by the server.

The system SHALL allow the owner to list token metadata and revoke an active
token. Expired and revoked tokens SHALL be rejected.

## Bearer authentication

Protected endpoints SHALL accept a valid personal token using the Bearer HTTP
authorization scheme. Authorization SHALL use current user memberships, roles,
permissions, and trusted tenant-host selection.

A Bearer-authenticated request SHALL NOT create or revoke personal tokens.

## CLI setup

`spcli` SHALL accept token input without requiring it in command-line arguments,
validate it before persistence, and report revoked or expired credentials without
attempting a TOTP refresh.
