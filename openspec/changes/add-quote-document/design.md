# Diseño

## Datos (sólo admin)

```rust
pub struct QuoteSettings {   // colección quote_settings, una por empresa
    company_id, company_name, address1, address2, phone, email, web,
    iva_rate: f64,           // 0.16
    retention_rate: f64,     // 0.0125
    logo_data_url: Option<String>, // imagen pequeña en data URL
}
pub struct ContactQuoteDefaults {   // Contact.quote_defaults
    abbreviation, currency ("MXN"|"USD"), language ("es"|"en"),
    iva: bool, retention: bool, validity_days: i32, advance_pct: f64,
    people: Vec<{ name, initials, email }>,
}
pub struct Quote {                  // colección quotes
    company_id, project_id, contact_id?, client_name, attention?, attention_initials?,
    folio_base: String,            // "261103-01"
    revision: i32,                 // 0 → "261103-01-00"
    date, currency, language, iva, retention,
    iva_rate, retention_rate,      // congeladas al crear
    discount: f64,                 // monto
    delivery_time: i32, delivery_unit ("dias"|"semanas"),
    validity_days, advance_pct, notes: Vec<String>,  // notas 6..8
    lines: Vec<{ item, quantity, description, unit_price, concept_id? }>,
    sent_at?, created_by, created_at,
}
```

## Reglas

- Folio base: fecha en Hermosillo `AAMMDD` y consecutivo del día `NN` (01, 02…)
  por empresa; se puede escribir uno a mano. Revisión 00; "Nueva revisión"
  crea otra cotización con el mismo folio base y la revisión siguiente, con
  los precios actuales de las partes.
- Valores que no vienen en la petición salen del cliente y, si no, de la
  plantilla: MXN, español, IVA sí, retención sí, 15 días, 50 %, 10 días
  hábiles.
- Partidas: por defecto las partes del proyecto con precio cotizado, en su
  orden; descripción = número de parte.
- Totales como la plantilla: parcial = Σ cant × P.U.; base = parcial −
  descuento; IVA = base × tasa si aplica; retención = base × tasa si aplica;
  NETO = base + IVA − retención. Resto = 100 − anticipo.
- Términos 1–5 con los textos de la hoja CONFIG en el idioma de la
  cotización; notas 6–8 libres (con las sugeridas de CONFIG).
- "Marcar como enviada": guarda la fecha y, si el proyecto está en Pedidos o
  Análisis, lo pasa a Cotizado.

## API

`GET/POST /api/admin/quote_settings`, `POST /api/admin/contacts/{id}/quote_defaults`,
`GET/POST /api/admin/projects/{id}/quotes`, `GET /api/admin/quotes/{id}` (con
totales y datos de empresa), `POST /api/admin/quotes/{id}/revise`,
`POST /api/admin/quotes/{id}/sent`.

## SPA

En la pestaña Cotizador: "Nueva cotización" (cliente, atención, moneda,
idioma, IVA, retención, descuento, entrega, validez, anticipo, notas) y la
lista de cotizaciones del proyecto. `/cotizaciones/:id` muestra el documento
A4 con el formato de la plantilla y los botones Guardar PDF, Nueva revisión y
Marcar como enviada (no se imprimen).
