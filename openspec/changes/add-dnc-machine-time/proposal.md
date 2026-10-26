# Tiempo de máquina por número de parte, medido en el taller

> Estado: **implementado en la rama `feat/tiempo-maquina-dnc`, pendiente de revisión**
> (Luis Alfredo + Daniel). Redactado 2026-10-26.

## Por qué

En el taller, el monitor local (taller-vision, en la Mac mini) ya lee las cajas DNC de las
máquinas (VF-3, VF-6, SL30, Shizuoka): sabe qué programa corre, cuánto tiempo y cuántos ciclos,
y lee la cabecera de cada programa. El post de Mastercam pone en la cabecera el número de
parte:

```
O0010
(O0010)
(FECHA - 14-08-26 HORA - 11:43)
(ZBL149-CST-Y261007-1.MCAM)
(PROYECTO - ZBL149)          ← opcional: la misma pieza puede ir a varios proyectos
```

El número de parte es el nombre de un `ProjectConcept`. Con eso cada parte puede mostrar cuánto
tiempo real de máquina lleva, sin captura manual, y se ve cómo avanzan los proyectos.

## Qué cambia

- **Colección nueva `machine_runs`**: una corrida = un intervalo en que una máquina trabajó un
  programa (no muestras por segundo): máquina, programa, número de parte y proyecto de la
  cabecera, inicio/fin, minutos activos, minutos cortando, ciclos. Única por
  (`company_id`, `source`, `external_id`): el monitor reenvía los últimos días cada 10 min y
  es un upsert.
- `POST /api/admin/machine_runs/ingest` (**solo admin**, máx. 2000 corridas por llamada) — lo usa
  el monitor con un token personal (`spat_…`).
- `GET /api/admin/projects/{id}/machine_time` (`view_projects`): minutos, corte, ciclos,
  máquinas y programas por número de parte, más totales.
- `GET /api/admin/machine_runs?from&to&status` (`view_projects`): corridas con su liga
  (`matched`, `no_part`, `not_found`, `ambiguous`) para ver qué números de parte llegan
  sin proyecto en el ERP.
- Solid: el detalle del proyecto muestra tiempo de máquina, corte, ciclos y última corrida, y por
  parte una columna "Máquina (real)" con las máquinas usadas.

## Liga corrida → parte (al leer, no se guarda)

La liga se calcula al leer, así que una parte dada de alta después recoge su tiempo anterior.
1. Número de parte normalizado (mayúsculas, sin espacios) = nombre del concepto. Proyectos
   cancelados no cuentan.
2. Si la cabecera trae proyecto: sólo proyectos cuyo código (letras+dígitos al inicio del título,
   `ZBL149 …`) es ése, o cuyo título lo contiene (`F-96`).
3. Si quedan varios: se prefieren los no entregados; si aún hay varios → `ambiguous` (no se suma a
   ninguno; se lista para corregir la cabecera).

## Relación con `add-shop-floor-tracking` (fase 4)

La fase 4 usa la rejilla manual (`resource_usages`) para horas y costo. Esto **no la toca**: es
tiempo medido, de solo lectura en la UI, en su propia colección. Más adelante se puede usar para
prellenar la rejilla o comparar capturado vs medido. Costo (dinero) queda fuera: sólo minutos.

## Efectos secundarios

- Ningún cambio a colecciones existentes. Un índice único nuevo.
- El token del monitor debe ser de un admin de `sp` (el endpoint escribe).
