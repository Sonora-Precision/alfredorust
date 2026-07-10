# Generalización multi-industria — Plan y diseño de G1

> Objetivo: convertir la app (hoy con supuestos de un taller de maquinado CNC)
> en un sistema de gestión **para cualquier tipo de empresa**, donde cada tenant
> hace lo que quiera. Documento vivo; se actualiza al avanzar. Autor: sesión
> 357e31ca (2026-07-09).

## Visión

Un solo sistema, multi-tenant, para PyMEs (arranque en México). Diferenciador:
**CFDI/SAT nativo + finanzas integradas + UI moderna**. La generalización NO debe
diluir eso.

## Decisiones tomadas (bloqueadas)

1. **Nivel de flexibilidad = módulos ricos componibles** (NO no-code tipo
   Airtable). Todos los módulos disponibles para toda empresa, cada uno
   configurable (etiquetas, pipelines, estados) y encendible. Funciona de caja.
   Campos personalizados como escape final **más adelante** (no en G1).
2. **Nada se bloquea por giro.** Un taller CNC puede además vender productos y dar
   cursos con citas — todo a la vez. Los módulos son interruptores por tenant
   (para no saturar el menú), no restricciones por industria.
3. **Las plantillas por giro son solo un atajo de arranque**: pre-encienden un set
   de módulos y siembran etiquetas/etapas/categorías para no empezar en blanco.
   Todo editable después; todos los módulos siempre disponibles en Configuración.
   Habrá preset "Genérico / lo configuro yo".
4. Verticales objetivo (todas): manufactura (actual), estética/salón, servicios/
   consultoría, clínica/consultorio, retail/comercio.

## Diagnóstico: qué ya es general vs qué está amarrado a CNC

**Ya general (el foso — no tocar):** multi-tenancy, auth TOTP, usuarios/roles/
permisos, finanzas completas (cuentas/categorías/transacciones/planes/pronósticos),
CFDI/SAT (válido para cualquier empresa mexicana), sistema de diseño.

**El patrón correcto ya existe:** `ConceptStatus` es un pipeline **definido por el
tenant** (nombres, colores, posición, flags inicial/terminal/cancelado). Es el
modelo a replicar. También son configurables: `Category`, `Resource` (catálogo),
`Contact`, `Account`, `Company.default_currency`.

**Amarrado a CNC (a generalizar):**

| # | Problema | Dónde | Arreglo |
|---|---|---|---|
| 1 | `ProjectStatus` = pipeline de 10 etapas CNC en enum Rust (`Análisis→…→Entrega`) + `next()` lineal | `src/models.rs:694` | Convertir a datos por-tenant (patrón `ConceptStatus`) |
| 2 | `ResourceType` fijo (Maquinaria/Vehículo/Equipo) | `src/models.rs:903` | Configurable (salón: Estilista/Silla/Sala) |
| 3 | Costeo solo por hora + "Operador" + grid "Horario 7–22" | ResourceUsages | Generalizar (no todos cobran por hora) |
| 4 | Vocabulario hardcodeado (Proyecto/Concepto/Operador/Costo-hora) | pages Solid + Askama | Capa de etiquetas configurables |
| 5 | Semillas incluyen literalmente el status "CNC" | `src/state/seed.rs:172` | Semillas por plantilla |
| 6 | No existe campo `industry`/vertical en `Company` | `src/models.rs:80` | Agregarlo — gancho de todo |

**Huecos de raíz (módulos nuevos, fuera de G1):**
- 🔴 **Agenda/Citas/Calendario** — no existe nada (confirmado). Hueco #1 para
  salón/clínica/servicios. → G2.
- **Catálogo de productos/servicios + precios** — hoy ítems ad-hoc por orden. → G3.
- **Inventario/Stock** (retail) + **POS**. → G4.
- **CRM** (contactos delgados), **facturación comercial** (cotización→pago),
  **notificaciones** (recordatorios de cita), **portal de reservas**. → G5.

## Roadmap por fases

- **G1 — Fundación componible** (este doc). Barato, alto impacto, desbloquea todo.
- **G2 — Módulo Agenda/Citas** (desbloquea salón/clínica/servicios).
- **G3 — Catálogo de productos/servicios + precios.**
- **G4 — Inventario/Stock + POS** (retail).
- **G5 — CRM + facturación comercial + notificaciones + portal de reservas.**

---

# Diseño de G1 — Fundación componible

Al terminar G1: cualquier empresa tiene todos los módulos disponibles, puede
encender/apagar y renombrar lo que quiera, y las operaciones actuales (pipeline
CNC fijo) pasan a ser configurables. **G1 NO construye Agenda/Catálogo/Inventario.**

## 1. Modelo de datos

`Company` gana dos campos retrocompatibles:
```rust
industry: Option<String>          // giro elegido en onboarding — informativo/preset
enabled_modules: Vec<String>      // módulos activos en el nav
```

**Registro de módulos** (en código, un solo lugar): lista canónica
`finance, cfdi, projects, orders, resources, agenda, catalog, inventory, pos, crm,
tiempo, reports`. Cada uno `{ id, default_label, nav_entries, permiso }`.

**Config del tenant** — doc nuevo `tenant_settings` (company-scoped), separado de
`Company` para no inflarla:
```jsonc
{ company_id, labels: { "concept": "Servicio", "resource": "Estilista", ... } }
```

**Pipeline de proyecto configurable** — `ProjectStatus` enum→datos. Nueva colección
`project_stages` `{ company_id, name, position, color, is_initial, is_terminal,
is_cancelled, is_active }` (idéntico patrón a `concept_statuses`). El `next()`
lineal pasa a "siguiente por posición".

## 2. Plantillas (solo atajo de arranque)

Registro en datos, ~1 archivo por giro. Ejemplo:
```jsonc
"salon": {
  enabled_modules: ["finance","cfdi","agenda","catalog","crm"],
  labels: { concept:"Servicio", resource:"Estilista", contact:"Cliente" },
  seed_stages: ["Agendada","En sala","Terminada","Pagada"],
  seed_categories: ["Servicios","Productos","Propinas"],
}
```
Al elegir giro → copia defaults a la config editable. Todo módulo sigue disponible
en Configuración; nada se esconde permanentemente. Preset "Genérico".

## 3. Frontend

- **`useLabels()`** — lee etiquetas del tenant con fallback al término canónico.
  Páginas cambian `"Concepto"` por `t('concept')`. Adopción incremental (primero
  páginas de operaciones).
- **Nav por módulo** — `solid/src/lib/nav.ts` gana campo `module`; el nav filtra
  por `enabled_modules ∩ permisos` (ya tiene el gate de permiso).
- **Configuración → Módulos** — toggles para encender/apagar cada módulo.

## 4. Migración / compatibilidad (crítico)

La empresa actual (Aurora/CNC) **no cambia de comportamiento**:
`industry="manufactura"`, **todos los módulos encendidos**, y una migración siembra
las 10 etapas CNC como `project_stages` mapeando el enum viejo de cada proyecto a
su `stage_id`. Shim traduce valores viejos. Cero downtime, cero pérdida de datos.

## 5. Sub-fases (cada una desplegable sola)

| | Qué | Riesgo | Nota |
|---|---|---|---|
| **G1.1** | Registro de módulos + `Company.enabled_modules` + nav por módulo + pantalla Configuración | Bajo | Empresa actual: todo encendido → sin cambio visible |
| **G1.2** | Capa de etiquetas (`tenant_settings` + `useLabels` + adoptar en páginas ops) | Bajo | Incremental |
| **G1.3** | Plantillas + paso de onboarding "¿a qué se dedica?" | Bajo | Se apoya en G1.1/G1.2 |
| **G1.4** | Pipeline de proyecto configurable (`ProjectStatus` enum→datos + migración) | Medio | El más delicado; al final ya con la fundación puesta |

Orden recomendado: G1.1 → G1.2 → G1.3 → G1.4. G1.1 da valor visible rápido y bajo
riesgo; G1.4 (lo delicado) al final.

## Estado

- [ ] G1.1  · [ ] G1.2  · [ ] G1.3  · [ ] G1.4
- (Actualizar aquí conforme se desplieguen.)
