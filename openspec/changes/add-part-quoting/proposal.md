# Cotizador por pieza (mejora 1 del flujo cotización → cobro)

> Estado: **aprobada** (Daniel Rivera, 2026-11-04: "Sí, el cotizador"; "costo del
> material (tocho)"). Depende de `add-part-material` (tocho por pieza).

## Por qué

Daniel cotiza así: por cada pieza calcula el peso del **tocho** (el stock del
que sale, con su densidad), lo multiplica por un factor (precio por kg del
material) y eso da el costo de material; el precio de la pieza es ese costo
× 3, 3.5 o 4 según el cliente y su criterio. Lo hace a mano en SolidWorks y
Excel. El sistema debe proponerle esos números y dejarle siempre la última
palabra sobre el precio.

Es la primera de seis mejoras: (1) cotizador, (2) precios aprendidos de los
CFDI de proveedores, (3) requisición por proveedor, (4) cotización en PDF,
(5) orden de compra y anticipo, (6) cierre y cobro.

## Qué cambia

- **Precio por kg por material** (lista de la empresa, sólo admin; arranca a
  mano, después se alimenta de los CFDI en la mejora 2).
- **Peso del tocho** calculado con las medidas del tocho y la densidad del
  material, o el peso que Daniel capture de SolidWorks.
- **Cotizador** en el proyecto (pestaña sólo admin): por pieza, kg, $/kg,
  costo de material, multiplicador (3.5 de inicio, editable), precio sugerido
  y el precio cotizado actual; totales; "Usar precio sugerido" copia el
  sugerido al precio cotizado de las piezas elegidas.

## Fuera de alcance (siguientes mejoras)

Multiplicador guardado por cliente, mano de obra y horas máquina, precios
desde CFDI, PDF de cotización.
