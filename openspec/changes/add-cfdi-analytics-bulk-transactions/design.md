# Design

## API

`POST /api/admin/cfdis/transactions/bulk`

Request:

```json
{ "uuids": ["CFDI-UUID"] }
```

Response:

```json
{
  "requested": 1,
  "created": 1,
  "updated": 0,
  "unchanged": 0,
  "skipped": 0,
  "errors": []
}
```

The endpoint accepts 1 to 5,000 UUIDs, deduplicates them, derives the company exclusively from the authenticated session, and processes items independently. An error entry contains only a requested UUID and a safe reason.

## Accounting mapping

- CFDI `I`: issued is income; received is expense.
- CFDI `E`: issued is expense; received is income.
- Cancelled CFDIs and types other than `I` or `E` are skipped.
- The managed fields are date, description, transaction type, category, SAT account direction, amount, linked planned entry, confirmation state, contact, CFDI UUID, currency, and folio. User-managed project and notes fields are preserved.
- Existing matching transactions are fully synchronized. Equal records are not written.
- The endpoint creates or synchronizes the CFDI-backed planned entry before the transaction and recalculates its coverage after a write.

## Idempotency and tenancy

The idempotency key is `(company_id, cfdi_uuid)` and is enforced by a partial unique MongoDB index for records that carry a CFDI UUID. The application-level mutex avoids redundant work within one process, while the database index protects concurrent workers and multiple application instances. A process that loses an insert race reloads and synchronizes the winning record. Every CFDI, planned entry, contact, category, account, and transaction lookup is scoped to the active company.

## Frontend

All analytics and selection operate over the full client-side filtered result, not only the current 50-row page. Selection is pruned when filters change. The bulk action reports created, updated, unchanged, skipped, and failed counts and refreshes CFDIs, transactions, and planned entries.

## Archived XML ZIP

`POST /api/admin/cfdis/archive` accepts the same UUID selection and returns `application/zip`. Every UUID must belong to the active tenant and have an archived XML; otherwise the endpoint fails without returning a partial archive. XML lookup is constrained to the active company's sanitized archive paths and never calls the SAT.
