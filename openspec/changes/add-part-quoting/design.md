# Diseño

## Datos

```rust
pub struct MaterialPrice {          // colección material_prices, una por material
    id, company_id,
    material: String,               // "Aluminio 6061" (mismo nombre que PartMaterial)
    price_per_kg: f64,              // MXN sin IVA
    source: String,                 // "manual" (después "cfdi")
    note: Option<String>,           // "F86241 HG Aceros"
    updated_by: ObjectId, updated_at: DateTime,
}
pub struct PartQuote {              // ProjectConcept.quote, sólo admin
    weight_kg: Option<f64>,         // peso del tocho de SolidWorks; vacío = calculado
    multiplier: Option<f64>,        // vacío = 3.5
}
```

## Cálculo

- Densidad (g/cm³) por palabra clave del material: aluminio 2.70 (7075:
  2.81), acero/4140/1018/1045 7.85, inoxidable 8.00, delrin/acetal 1.41, G10
  1.85, nylamid/nylon 1.15, latón 8.50, cobre 8.96. Sin coincidencia → sin
  peso calculado.
- Volumen del tocho: espesor × ancho × largo (in³); redondo: π (d/2)² × largo.
  kg = in³ × 16.387064 × densidad ÷ 1000.
- $/kg: el precio del material exacto; si no hay, el de su base ("Delrin
  negro" → "Delrin", "Aluminio 6061" → "Aluminio").
- Costo de material por pieza = kg × $/kg. Precio sugerido = costo ×
  multiplicador, redondeado al peso hacia arriba.
- Cada renglón dice qué falta si no hay sugerido: material, tocho o $/kg.

## API (sólo admin; es dinero)

- `GET/POST /api/admin/material_prices` (`{material, price_per_kg, note}`;
  `price_per_kg: null` lo borra).
- `GET /api/admin/projects/{id}/quote`: renglones y totales.
- `POST /api/admin/project_concepts/{id}/quote` `{weight_kg, multiplier}`.
- `POST /api/admin/projects/{id}/quote/apply` `{concept_ids}`: copia el
  sugerido a `unit_price`.
