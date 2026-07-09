# PDF / Typst preview — archived 2026-07-09

The Typst-based PDF preview (`/pdf` editor + `POST /pdf/preview`) was removed from
the build because it was no longer used by the UI and its transitive deps
(`typst` → `hayagriva` → `citationberg` → `quick-xml 0.38`) carried unpatched
RustSec advisories (XML-parsing DoS) plus a large compile/binary cost.

**Full working state is preserved at git tag `pdf-typst-backup`.** These source
files are kept here as a quick reference copy.

## To restore
1. `git checkout pdf-typst-backup -- src/routes/pdf.rs src/templates/pdf` (or copy
   `archive/pdf-typst/pdf.rs` → `src/routes/pdf.rs` and
   `archive/pdf-typst/templates-pdf/` → `src/templates/pdf/`).
2. `Cargo.toml`: re-add
   ```
   typst = "0.14"
   typst-pdf = "0.14"
   typst-assets = "0.14"
   ```
   (prefer newer patched versions if available).
3. `src/routes/mod.rs`: re-add `pub mod pdf;` and `pub use pdf::*;`.
4. `src/main.rs`: re-add the routes
   ```
   .route("/pdf", get(routes::pdf_editor))
   .route("/pdf/preview", post(routes::pdf_preview))
   ```
5. `src/openapi.rs`: re-add `crate::routes::pdf::pdf_preview,` to the paths list.
6. Optional client bits (also removed): the `spcli pdf preview` command in
   `crates/spcli/src/main.rs` and `previewPdf` in `solid/src/lib/api/misc.ts`
   (+ `PdfPreviewResponse` in `types.ts`).
