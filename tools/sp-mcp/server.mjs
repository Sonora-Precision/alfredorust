#!/usr/bin/env node
// Conector MCP para la plataforma alfredodev / Sonora Precision.
//
// Habla directo con la API HTTP usando un token de acceso personal (spat_...)
// en `Authorization: Bearer`. Lecturas libres; toda escritura exige
// `confirm: true`, y las operaciones peligrosas están bloqueadas (se hacen en la web).
//
// Configuración por variables de entorno:
//   SPCLI_TOKEN      token spat_... (en Windows también se lee de HKCU\Environment)
//   SP_COMPANY       slug de la empresa por defecto (default: sp)
//   SP_BASE_DOMAIN   dominio raíz (default: alfredorivera.dev)
//   SP_LOGIN_HOST    subdominio de login (default: app)

import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE_DOMAIN = process.env.SP_BASE_DOMAIN || "alfredorivera.dev";
const LOGIN_HOST = process.env.SP_LOGIN_HOST || "app";
const DEFAULT_COMPANY = process.env.SP_COMPANY || "sp";
const MAX_CHARS = 80_000;
const TIMEOUT_MS = 300_000; // SAT verify puede tardar minutos

// ---------------------------------------------------------------------------
// Catálogo de rutas (espejo de src/main.rs). `w` = escritura.
// ---------------------------------------------------------------------------
const ROUTES = [
  ["GET", "/api/me", "Usuario actual, rol y empresas"],
  ["GET", "/api/me/companies", "Empresas a las que pertenece el usuario"],
  ["GET", "/api/onboarding/status", "Checklist de configuración inicial de la empresa"],
  ["GET", "/api/tiempo", "Línea de tiempo"],

  ["GET", "/api/admin/companies", "Listar empresas"],
  ["GET", "/api/admin/companies/{id}", "Ver empresa"],
  ["POST", "/api/admin/companies", "Crear empresa"],
  ["POST", "/api/admin/companies/{id}/update", "Actualizar empresa"],
  ["GET", "/api/admin/companies/{id}/cfdi/jobs", "Jobs de descarga SAT"],
  ["GET", "/api/admin/companies/{id}/cfdi/jobs/{job_id}", "Estado de un job SAT"],
  ["GET", "/api/admin/companies/{id}/cfdi/cron", "Configuración de sincronización automática CFDI"],
  ["GET", "/api/admin/companies/{id}/cfdis/archived", "CFDIs archivados"],
  ["POST", "/api/admin/companies/{id}/cfdi/download", "Iniciar descarga masiva SAT (consume cuota SAT)"],

  ["GET", "/api/admin/users", "Listar usuarios"],
  ["GET", "/api/admin/users/{id}", "Ver usuario"],
  ["POST", "/api/admin/users", "Crear usuario"],
  ["POST", "/api/admin/users/{id}/update", "Actualizar usuario"],
  ["POST", "/api/admin/users/{id}/delete", "Borrar usuario"],

  ["GET", "/api/admin/cfdis/data", "Listar CFDIs (filtros/paginación por query)"],
  ["GET", "/api/admin/cfdis/{uuid}", "Ver CFDI"],
  ["POST", "/api/admin/cfdis/archive", "Archivar CFDIs"],
  ["POST", "/api/admin/cfdis/transactions/bulk", "Crear transacciones desde CFDIs"],
  ["POST", "/api/admin/cfdis/{uuid}/check-status", "Consultar estatus del CFDI en el SAT"],
  ["POST", "/api/sat/cfdi/download", "Iniciar descarga SAT (empresa activa)"],

  ["GET", "/api/admin/sat-configs", "Listar configuraciones FIEL"],
  ["GET", "/api/admin/sat-configs/{id}", "Ver configuración FIEL"],
  ["POST", "/api/admin/sat-configs", "Crear configuración FIEL"],
  ["POST", "/api/admin/sat-configs/{id}/update", "Actualizar configuración FIEL"],
  ["POST", "/api/admin/sat-configs/{id}/delete", "Borrar configuración FIEL"],

  ...crud("accounts", "cuentas"),
  ...crud("categories", "categorías"),
  ...crud("contacts", "contactos"),
  ...crud("recurring-plans", "planes recurrentes"),
  ["POST", "/api/admin/recurring-plans/{id}/generate", "Generar movimientos planeados del plan"],
  ...crud("planned-entries", "movimientos planeados"),
  ["POST", "/api/admin/planned-entries/{id}/pay", "Pagar un movimiento planeado"],
  ["POST", "/api/admin/planned-entries/bulk-pay", "Pagar varios movimientos planeados"],
  ["GET", "/api/admin/transactions/data", "Listar transacciones (filtros/paginación por query)"],
  ["GET", "/api/admin/transactions/{id}", "Ver transacción"],
  ["POST", "/api/admin/transactions", "Crear transacción"],
  ["POST", "/api/admin/transactions/{id}/update", "Actualizar transacción"],
  ["POST", "/api/admin/transactions/{id}/delete", "Borrar transacción"],
  ...crud("forecasts", "pronósticos"),

  ...crud("orders", "órdenes de servicio"),
  ["POST", "/api/admin/orders/{id}/complete", "Completar orden (genera transacción)"],
  ...crud("projects", "proyectos"),
  ["POST", "/api/admin/projects/{id}/advance", "Avanzar estatus del proyecto"],
  ["GET", "/api/admin/projects/{project_id}/concepts", "Conceptos del proyecto"],
  ["POST", "/api/admin/projects/{project_id}/concepts", "Crear concepto en proyecto"],
  ["GET", "/api/admin/projects/{project_id}/status_summary", "Resumen de estatus del proyecto"],
  ["POST", "/api/admin/project_concepts/{id}/update", "Actualizar concepto"],
  ["POST", "/api/admin/project_concepts/{id}/advance", "Avanzar concepto"],
  ["POST", "/api/admin/project_concepts/{id}/delete", "Borrar concepto"],
  ["GET", "/api/admin/concept_statuses", "Listar estatus de conceptos"],
  ["POST", "/api/admin/concept_statuses", "Crear estatus de concepto"],
  ["POST", "/api/admin/concept_statuses/{id}/update", "Actualizar estatus de concepto"],
  ["POST", "/api/admin/concept_statuses/{id}/delete", "Borrar estatus de concepto"],

  ...crud("resources", "recursos"),
  ...crud("resource_logs", "bitácoras de recursos"),
  ["POST", "/api/admin/resource_logs/{id}/end", "Cerrar bitácora de recurso"],
  ...crud("resource_usages", "usos de recursos"),
  ["GET", "/api/admin/resource_usages/grid", "Rejilla horaria de usos"],
  ["POST", "/api/admin/resource_usages/grid", "Guardar rejilla horaria de usos"],
  ["GET", "/api/admin/resource_usages/{id}/allocations", "Asignaciones de un uso"],
  ["POST", "/api/admin/resource_usages/{id}/allocations", "Guardar asignaciones de un uso"],
].map(([method, path, desc]) => ({ method, path, desc, re: toRegex(path) }));

// Se hacen sólo desde la web: borrados masivos, borrar empresa, tokens, TOTP,
// y subidas multipart que este conector no soporta.
const BLOCKED = [
  [/\/delete_all$/, "borrado masivo"],
  [/^\/api\/admin\/companies\/[^/]+\/delete$/, "borrar empresa"],
  [/^\/api\/account(\/|$)/, "cuenta/tokens/TOTP"],
  [/\/upload$/, "subida de archivos (multipart)"],
];

function crud(slug, label) {
  const base = `/api/admin/${slug}`;
  return [
    ["GET", base, `Listar ${label}`],
    ["GET", `${base}/{id}`, `Ver uno de ${label}`],
    ["POST", base, `Crear en ${label}`],
    ["POST", `${base}/{id}/update`, `Actualizar en ${label} (envía el registro completo)`],
    ["POST", `${base}/{id}/delete`, `Borrar en ${label}`],
  ];
}

function toRegex(path) {
  return new RegExp("^" + path.replace(/\{[^}]+\}/g, "[^/?#]+") + "$");
}

function findRoute(method, path) {
  return ROUTES.find((r) => r.method === method && r.re.test(path));
}

// ---------------------------------------------------------------------------
// Token: variable de entorno o, en Windows, la variable de usuario del registro
// (por si la app que lanzó el conector arrancó antes de crearla).
// ---------------------------------------------------------------------------
function readToken() {
  let token = process.env.SPCLI_TOKEN?.trim();
  if (!token && process.platform === "win32") {
    try {
      const out = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "SPCLI_TOKEN"], {
        encoding: "utf8",
        windowsHide: true,
      });
      token = out.match(/SPCLI_TOKEN\s+REG_\w+\s+(\S+)/)?.[1];
    } catch {
      // no existe
    }
  }
  if (!token || !/^spat_\S+$/.test(token)) {
    throw new Error(
      "No hay token válido. Crea uno en Mi cuenta → Tokens de acceso y guárdalo en la variable de entorno SPCLI_TOKEN."
    );
  }
  return token;
}

function slugOf(company) {
  const slug = (company || DEFAULT_COMPANY).toLowerCase();
  if (!/^[a-z0-9-]+$/.test(slug)) throw new Error(`Slug de empresa inválido: ${company}`);
  return slug;
}

function hostFor(company) {
  const slug = slugOf(company);
  if (process.env.SP_API_ORIGIN) return `${slug}.${new URL(process.env.SP_API_ORIGIN).host}`;
  return `https://${slug}.${BASE_DOMAIN}`;
}

// SP_API_ORIGIN (p. ej. http://localhost:8090) apunta todo a un servidor local o
// de pruebas. Como Windows no resuelve slug.localhost, la petición va al origen y
// la empresa viaja en el encabezado Host (igual que spcli).
function target(path, company) {
  const local = process.env.SP_API_ORIGIN;
  const isMe = path.startsWith("/api/me");
  if (local) {
    const u = new URL(local);
    return { base: local, host: isMe ? u.host : `${slugOf(company)}.${u.host}` };
  }
  return { base: isMe ? `https://${LOGIN_HOST}.${BASE_DOMAIN}` : hostFor(company) };
}

// node:http(s) en lugar de fetch: fetch ignora el encabezado Host, que se
// necesita para elegir la empresa contra un servidor local.
function request(url, { method, headers, body }) {
  const mod = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(url, { method, headers, timeout: TIMEOUT_MS }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          ok: res.statusCode >= 200 && res.statusCode < 300,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        })
      );
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error(`Sin respuesta después de ${TIMEOUT_MS / 1000}s`)));
    req.on("error", (e) => reject(new Error(`No se pudo conectar con ${url.host}: ${e.message}`)));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function call(method, path, { company, query, body } = {}) {
  const { base, host } = target(path, company);
  const url = new URL(path, base);
  for (const [k, v] of Object.entries(query || {})) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  }
  const payload = body !== undefined ? JSON.stringify(body) : undefined;
  const res = await request(url, {
    method,
    headers: {
      Authorization: `Bearer ${readToken()}`,
      Accept: "application/json",
      ...(host ? { Host: host } : {}),
      ...(payload !== undefined
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
        : {}),
    },
    body: payload,
  });
  const { text } = res;
  const type = res.headers["content-type"] || "";
  if (/^\s*<!doctype html/i.test(text) || (type.includes("text/html") && res.ok)) {
    throw new Error(`La ruta ${method} ${path} no existe en el servidor (devolvió la página web).`);
  }
  if (res.status >= 300 && res.status < 400) {
    throw new Error(`HTTP ${res.status}: redirección a ${res.headers.location} — token rechazado o sesión requerida.`);
  }
  if (!res.ok) {
    const hint = res.status === 401 ? " (token rechazado, vencido o revocado)" : res.status === 403 ? " (sin permiso)" : "";
    throw new Error(`HTTP ${res.status}${hint}: ${text.slice(0, 2000)}`);
  }
  return text;
}

// Nunca regresar secretos al modelo (p. ej. el detalle de usuario trae el TOTP).
const SENSITIVE_KEY = /secret|password|passwd|token|totp|private_key|key_pass/i;

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SENSITIVE_KEY.test(k) && v !== null && v !== "" ? "[oculto]" : redact(v)])
    );
  }
  return value;
}

function format(text) {
  let out = text;
  try {
    out = JSON.stringify(redact(JSON.parse(text)), null, 2);
  } catch {
    // no es JSON; se regresa tal cual
  }
  if (out.length > MAX_CHARS) {
    out = out.slice(0, MAX_CHARS) + `\n\n… [recortado: ${out.length} caracteres en total; usa filtros/paginación en query]`;
  }
  return out;
}

const ok = (text) => ({ content: [{ type: "text", text }] });
const fail = (err) => ({ content: [{ type: "text", text: `Error: ${err.message || err}` }], isError: true });

function splitPath(raw) {
  const u = new URL(raw, "https://x");
  return { path: u.pathname, query: Object.fromEntries(u.searchParams) };
}

// ---------------------------------------------------------------------------
// Servidor MCP
// ---------------------------------------------------------------------------
const server = new McpServer({ name: "sonora-platform", version: "0.1.0" });

const companyArg = z
  .string()
  .optional()
  .describe(`Slug de la empresa (subdominio). Default: ${DEFAULT_COMPANY}`);

server.registerTool(
  "sp_routes",
  {
    title: "Rutas de la plataforma",
    description:
      "Lista las rutas de la API disponibles (método, ruta, descripción). Úsala para descubrir qué leer o escribir. " +
      "Para la forma exacta de los cuerpos JSON consulta src/routes/admin y src/models.rs del repo alfredorust.",
    inputSchema: { filter: z.string().optional().describe("Texto para filtrar por ruta o descripción") },
    annotations: { readOnlyHint: true },
  },
  async ({ filter }) => {
    const f = filter?.toLowerCase();
    const lines = ROUTES.filter((r) => !f || r.path.includes(f) || r.desc.toLowerCase().includes(f)).map(
      (r) => `${r.method.padEnd(4)} ${r.path} — ${r.desc}`
    );
    return ok(lines.join("\n") || "Sin coincidencias.");
  }
);

server.registerTool(
  "sp_me",
  {
    title: "Quién soy",
    description: "Usuario autenticado por el token, su rol y las empresas (slugs) a las que tiene acceso.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  async () => {
    try {
      return ok(format(await call("GET", "/api/me")));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "sp_get",
  {
    title: "Leer datos",
    description:
      "Lectura (GET) de cualquier ruta del catálogo, p. ej. /api/admin/accounts o /api/admin/projects/{id}. " +
      "Los parámetros de búsqueda pueden ir en `query` o en la ruta (?from=...). No modifica nada.",
    inputSchema: {
      path: z.string().describe("Ruta que empieza con /api/"),
      query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
      company: companyArg,
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async ({ path: raw, query, company }) => {
    try {
      const { path, query: inline } = splitPath(raw);
      if (!findRoute("GET", path)) throw new Error(`GET ${path} no está en el catálogo. Usa sp_routes.`);
      return ok(format(await call("GET", path, { company, query: { ...inline, ...query } })));
    } catch (e) {
      return fail(e);
    }
  }
);

server.registerTool(
  "sp_write",
  {
    title: "Crear / modificar / borrar",
    description:
      "Escritura (POST) en la plataforma: crear, actualizar, borrar, pagar, avanzar, etc. " +
      "REGLA: antes de llamar con confirm=true, muestra al usuario exactamente qué se va a hacer (empresa, ruta, datos) " +
      "y espera su sí explícito en el chat. Sin confirm=true sólo devuelve una vista previa y no envía nada. " +
      "Los updates reemplazan el registro: lee primero con sp_get y manda el registro completo.",
    inputSchema: {
      path: z.string().describe("Ruta POST del catálogo, p. ej. /api/admin/accounts/{id}/update"),
      body: z.any().optional().describe("Cuerpo JSON"),
      company: companyArg,
      confirm: z.boolean().optional().describe("true sólo después de que el usuario aprobó en el chat"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  async ({ path, body, company, confirm }) => {
    try {
      const blocked = BLOCKED.find(([re]) => re.test(path));
      if (blocked) throw new Error(`Bloqueado en el conector (${blocked[1]}). Hazlo desde la web.`);
      const route = findRoute("POST", path);
      if (!route) throw new Error(`POST ${path} no está en el catálogo. Usa sp_routes.`);
      const target = hostFor(company);
      if (confirm !== true) {
        return ok(
          `VISTA PREVIA — no se envió nada.\n` +
            `Empresa: ${target}\nAcción: ${route.desc}\nPOST ${path}\n` +
            `Datos:\n${JSON.stringify(body ?? null, null, 2)}\n\n` +
            `Pide confirmación al usuario y vuelve a llamar con confirm=true.`
        );
      }
      return ok(format((await call("POST", path, { company, body: body ?? {} })) || "OK"));
    } catch (e) {
      return fail(e);
    }
  }
);

if (process.argv.includes("--check")) {
  // Prueba rápida sin MCP: node server.mjs --check
  call("GET", "/api/me")
    .then((t) => {
      const me = JSON.parse(t);
      console.log(`OK: ${me.username} (${me.role}) — empresa activa: ${me.company_slug}`);
      console.log(`Empresas: ${me.companies.map((c) => c.slug).join(", ")}`);
    })
    .catch((e) => {
      console.error(`ERROR: ${e.message}`);
      process.exit(1);
    });
} else {
  await server.connect(new StdioServerTransport());
}
