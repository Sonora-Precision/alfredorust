# Cotización en PDF desde el proyecto (mejora 4)

> Estado: **aprobada** (Daniel Rivera, 2026-11-04: "Sí, la 4"). Usa el precio
> cotizado de cada parte (`add-part-quoting`).

## Por qué

Daniel cotiza con `00-PLANTILLA COTIZACIONES SONORA PRECISION V5.xlsm`: datos
de la empresa y logo, cliente y "atención a", folio `AAMMDD-NN-REV`, partidas
(ITEM · CANT. · DESCRIPCIÓN · P. UNITARIO · TOTAL), total parcial, descuento,
IVA 16 %, retención ISR 1.25 %, NETO y términos 1–5 con validez, anticipo,
entrega, resto contra entrega y moneda, en español o inglés, con valores por
cliente (hoja CLIENTES). El sistema debe sacar esa misma cotización desde el
proyecto, sin volver a capturar las partes.

## Qué cambia

- **Datos de la empresa para cotizar** (nombre, direcciones, teléfono, correo,
  web, logo, tasas de IVA y retención), una vez por empresa.
- **Valores de cotización por cliente** en su contacto: abreviatura, moneda,
  idioma, IVA, retención, días de validez, % de anticipo y personas (nombre,
  iniciales, correo) para "Atención a".
- **Cotización** guardada en el proyecto: folio con revisión, partidas tomadas
  de las partes con precio cotizado (o editadas), términos y totales
  calculados igual que la plantilla. Cada revisión es una cotización nueva
  con el mismo folio base.
- **Documento** A4 con el formato de la plantilla, en español o inglés, para
  imprimir o "Guardar PDF" desde el navegador.
- **Marcar como enviada** pasa el proyecto a Cotizado.

## Fuera de alcance

Mandar el correo desde el sistema, PDF generado en el servidor, orden de
compra y anticipo (mejora 5).
