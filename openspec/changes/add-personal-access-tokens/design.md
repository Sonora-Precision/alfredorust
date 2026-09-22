# Design

Tokens use `spat_<public-id>_<256-bit-secret>`. MongoDB stores the public id,
SHA-256 digest, short display prefix, owner, timestamps, name, expiration, and
revocation state. The public id enables indexed lookup; the digest comparison is
constant-time. High entropy makes a password hashing function unnecessary.

The existing session middleware accepts either a session cookie or an
`Authorization: Bearer` token and then builds the same live `UserWithCompany`
context. Tenant selection remains host-based. Token creation and revocation
require a cookie-authenticated browser session, so a stolen token cannot mint or
manage credentials.

The plaintext is present only in the create response. The CLI reads it from
stdin (or an environment variable for automation), validates it against
`/api/me`, and stores it in the existing encrypted, user-scoped credential
envelope. A rejected, expired, or revoked token is never refreshed automatically.
