# Material por número de parte, recepción de factura y cortes de sierra

> Estado: **aprobada para cortes 1 y 2** (Daniel Rivera, 2026-11-03: "Sí,
> arranca"). Cortes 3 y 4 quedan propuestos. Retoma el §1.6 "Material
> requerido" de `add-shop-floor-tracking`, que nunca se programó.

## Por qué

Daniel decide qué material pedir para cada pieza con un Excel
(`Cantidades_Vulcan_Doublemint_v2.xlsx`: material, piezas, tocho por pieza y
barra a pedir). Cuando llega la factura del proveedor, que a veces trae otra
medida porque era lo que tenía, la compara a mano contra lo pedido y después
arma la lista de cortes de la Sierra cinta. El 2026-11-03 se hizo esto con la
factura F86241 de HG Aceros y un script; la idea es que lo haga el sistema.

## Qué cambia

1. **Corte 1 — Material por número de parte.** Cada parte guarda su material
   (tipo, forma), el tocho por pieza en pulgadas (espesor × ancho × largo de
   corte), la barra a pedir, "surtido por cliente" y "pedido". El estado se
   deriva: Surtido por cliente · Cortado · Recibido · Pedido · Pendiente.
   Seguimiento lo muestra en cada parte. Se importa una vez del Excel de
   Daniel, con vista previa.
2. **Corte 2 — Recepción de factura.** Una recepción de material se crea desde
   un CFDI ya descargado del SAT (por UUID) o con sus renglones capturados. Cada
   concepto se lee como barra ("Aluminio solera 6061 de 1/8" X 2" X 144"") y se
   cruza contra las partes: ✅ como se pidió · 🟡 otra medida que sirve · 🔴
   no sirve · ⚪ sin pedido, con cuántas piezas salen. Daniel confirma a qué
   parte va cada barra. Sin efectos financieros ni precios.
3. **Corte 3 (propuesto) — Lista de cortes en la fila de la Sierra cinta**,
   con ancho de corte por empresa (1/16" por defecto); al terminar el corte se
   marca "Material habilitado".
4. **Corte 4 (propuesto) — Retazos** reutilizables con lo que sobra.

## Fuera de alcance

Costos y gastos de material, inventario por kilo, compras al proveedor.
