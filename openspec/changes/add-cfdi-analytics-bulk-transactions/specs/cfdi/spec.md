# CFDI Bulk Transaction Delta

## Requirements

### Requirement: Filtered CFDI analytics are consistent

The CFDI explorer SHALL apply search, direction, currency, issuer, and inclusive date filters to the same data set used by KPIs, charts, export, pagination, and bulk selection.

#### Scenario: Admin filters by issuer and date

- GIVEN imported CFDIs from multiple issuers and dates
- WHEN an admin selects an issuer and date range
- THEN every visible aggregate and selectable item uses only matching CFDIs

### Requirement: Bulk CFDI transaction synchronization is idempotent

The system SHALL synchronize at most one transaction per company and CFDI UUID.

#### Scenario: Selected CFDI has no transaction

- GIVEN a supported, active CFDI owned by the active company
- WHEN an admin synchronizes its UUID
- THEN the system creates one linked transaction

#### Scenario: Selected CFDI transaction differs

- GIVEN a CFDI-backed transaction with stale managed fields
- WHEN an admin synchronizes its UUID
- THEN the system updates the managed fields
- AND preserves a single transaction for the company and UUID

#### Scenario: Selected CFDI transaction is current

- GIVEN a CFDI-backed transaction whose managed fields match the CFDI
- WHEN an admin synchronizes its UUID again
- THEN the system performs no write
- AND reports the item as unchanged

### Requirement: Bulk CFDI synchronization preserves tenant isolation

The endpoint SHALL derive company context from the authenticated admin and SHALL NOT reveal or mutate CFDIs belonging to another company.

#### Scenario: UUID belongs to another tenant

- GIVEN an admin for company A and a CFDI UUID owned only by company B
- WHEN the admin submits that UUID
- THEN no company B record is read into the response or mutated
- AND the UUID is reported as unavailable

### Requirement: CFDI accounting direction handles credit notes

The system SHALL map invoice CFDIs (`I`) by document direction and SHALL invert that direction for credit-note CFDIs (`E`).

#### Scenario: Issued credit note

- GIVEN an issued CFDI with type `E`
- WHEN it is synchronized
- THEN the resulting transaction is an expense

#### Scenario: Received credit note

- GIVEN a received CFDI with type `E`
- WHEN it is synchronized
- THEN the resulting transaction is income
