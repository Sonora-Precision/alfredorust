## ADDED Requirements

### Requirement: The admin creates a quote from the project

The system SHALL let only admins create a quote for a project with a folio
"AAMMDD-NN-RR" (Hermosillo date, daily sequence, revision 00), lines from the
parts with a quoted unit price, and terms from the request, else the client
defaults, else MXN, Spanish, IVA and retention applied, 15 days, 50 percent
advance and 10 business days.

#### Scenario: First quote of the day

- GIVEN project ZBL136 has parts priced 1,250 x 3 and 3,850 x 3
- WHEN the admin creates its quote on 2026-11-03 for Brabatech
- THEN the quote folio is "261103-01-00" with two lines
- AND it uses Brabatech's 5 days validity and 50 percent advance

#### Scenario: Programmer cannot quote

- WHEN a programmer requests the quotes of a project
- THEN the request is rejected

### Requirement: Quote totals follow the shop's template

The system SHALL compute subtotal as the sum of quantity times unit price,
apply the discount, add IVA and subtract the ISR retention on the discounted
subtotal when they apply, and report the net and the remaining percent after
the advance.

#### Scenario: Totals like quote 261103-01-00

- GIVEN lines that add up to 69,600 with no discount, IVA 16 percent and retention 1.25 percent
- WHEN the quote is read
- THEN IVA is 11,136, retention is 870 and the net is 79,866

### Requirement: Quotes have revisions and are marked sent

The system SHALL create a new revision with the same folio base, the next
revision number and the current part prices, and SHALL move the project to
Cotizado when a quote is marked sent while the project is in Pedidos or
Análisis.

#### Scenario: Revision

- GIVEN quote 261103-01-00
- WHEN the admin creates a new revision
- THEN a quote 261103-01-01 exists and 261103-01-00 is unchanged

#### Scenario: Sent moves the project

- GIVEN the project is in Análisis
- WHEN the admin marks its quote sent
- THEN the project is Cotizado
