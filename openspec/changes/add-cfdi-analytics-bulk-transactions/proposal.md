# CFDI analytics and bulk transaction synchronization

## Why

The CFDI explorer has useful aggregate totals but cannot narrow analysis by issuer or invoice date. It also separates fiscal documents from finance without a controlled way to turn selected invoices into real transactions.

## What changes

- Add issuer and inclusive date filters to the CFDI explorer.
- Add count, document-type, issuer, and date-based visualizations computed from the filtered set.
- Allow admins to select individual CFDIs or every CFDI in the current filtered result.
- Allow admins to download every selected archived XML in one ZIP, including selections spanning every filtered page.
- Add a tenant-scoped bulk endpoint that creates, updates, or leaves CFDI-backed transactions unchanged.
- Make transaction synchronization idempotent by company and CFDI UUID.

## Side effects

Bulk synchronization writes finance transactions and recalculates linked CFDI-backed planned-entry status. ZIP export reads the existing tenant archive only. Neither operation calls the SAT or creates payments for unsupported or cancelled CFDIs.
