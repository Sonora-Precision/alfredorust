# Diseño

## 1. Material de la parte (corte 1)

```rust
pub struct PartMaterial {
    pub material: Option<String>,    // "Aluminio 6061", "4140", "Delrin negro", "G10"
    pub shape: Option<String>,       // "solera", "placa", "redondo"
    pub thickness: Option<f64>,      // tocho por pieza, pulgadas
    pub width: Option<f64>,          // (redondo: diámetro en thickness, width vacío)
    pub length: Option<f64>,         // largo de corte
    pub bar_to_order: Option<String>,// texto libre: "1/2" X .625" X 80""
    pub customer_supplied: bool,
    pub ordered: bool,
    pub notes: Option<String>,
}
// ProjectConcept gana: material: Option<PartMaterial>
```

Medidas en pulgadas decimales para poder calcular; la barra a pedir sigue en
texto. Estado derivado (el primero que aplique): Surtido por cliente → Cortado
(paso "Material habilitado" ✔) → Recibido (alguna barra de una recepción
asignada a la parte) → Pedido → Pendiente.

`POST /api/admin/project_concepts/{id}/material` (reemplaza el material; sólo
quien gestiona el tablero o el admin). El DTO de partes devuelve `material` y
`material_status`. Nadie ve precios del material.

## 2. Recepción de material (corte 2)

```rust
pub struct MaterialReceipt {
    id, company_id,
    supplier: String,            // "HG Aceros y Metales de Hermosillo"
    folio: Option<String>,       // "F86241"
    cfdi_uuid: Option<String>,
    received_at: DateTime,
    lines: Vec<ReceiptLine>,
    created_by: ObjectId, created_at: DateTime,
}
pub struct ReceiptLine {
    line: i32, description: String, quantity: f64, unit: String,
    material: Option<String>, shape: Option<String>,
    thickness: Option<f64>, width: Option<f64>, length: Option<f64>,
    pieces: f64,                 // "( 1 pz )" → 1; sin dato → 1
    concept_ids: Vec<ObjectId>,  // partes a las que Daniel la asignó
}
```

- **Lectura del concepto:** fracciones ("1 1/4", "1/8"), decimales (".625") y
  enteros, separados por "x"; las comillas son opcionales. Material por
  palabras clave (6061, 7075, 4140, 1018, delrin/acetal, g10, nylamid; base
  aluminio/acero); forma por solera/placa/redondo/barra. Sin aleación →
  "Aluminio" a secas y el cruce lo avisa.
- **Cruce:** una barra sirve a una parte si es del mismo material y su
  sección cubre la del tocho en cualquier orientación (dimensiones ordenadas).
  Igual (±0.005") → ✅; mayor → 🟡 con la nota "ancho 2" en vez de 1.75"";
  menor → no se sugiere. Piezas que salen = ⌊largo ÷ (largo de corte + 1/16")⌋
  por barra. Por parte: piezas pedidas (cantidad − producidas) contra piezas
  que salen de sus barras asignadas.
- **Crear:** `POST /api/production/material_receipts` con `{cfdi_uuid}`
  (toma emisor, folio y conceptos del CFDI guardado de la empresa) o con
  `{supplier, folio, lines: [{description, quantity, unit}]}`.
- **Leer:** `GET /api/production/material_receipts` y `…/{id}`: renglones
  leídos, sugerencias por renglón y resumen por parte.
- **Asignar:** `POST …/{id}/lines/{line}/assign` `{concept_ids}`. Una barra
  puede ir a varias partes y una parte recibir varias barras.
- Permisos: crear y asignar sólo `manage_production_board` (admin); ver con
  `view_projects` o `view_production_board`. No se guardan precios del CFDI.

## 3. Lista de cortes (corte 3, propuesto)

Por barra asignada: largo de corte, piezas, sobrante. Ancho de corte por
empresa (1/16" por defecto). Cada parte entra en la fila de la Sierra cinta
(design §9c de `add-production-board`) con la etiqueta "Corte N pz @ L""; al
"Terminar trabajo" se marca "Material habilitado".

## 4. Retazos (corte 4, propuesto)

El sobrante de cada barra queda como retazo con material y medidas; al cruzar
una parte nueva se sugieren retazos antes que comprar.
