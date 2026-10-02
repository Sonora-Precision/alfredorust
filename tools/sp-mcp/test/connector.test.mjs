// Prueba de punta a punta: Claude (cliente MCP) → conector → API falsa.
// Nunca toca producción: usa un token de prueba y SP_API_ORIGIN local.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startMockApi, TEST_TOKEN } from "./mock-api.mjs";

const SERVER = fileURLToPath(new URL("../server.mjs", import.meta.url));
let api;
let client;

before(async () => {
  api = await startMockApi();
  client = new Client({ name: "test", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [SERVER],
      env: { ...process.env, SPCLI_TOKEN: TEST_TOKEN, SP_API_ORIGIN: api.origin, SP_COMPANY: "sp" },
    })
  );
});

after(async () => {
  await client?.close();
  api?.close();
});

const call = (name, args = {}) => client.callTool({ name, arguments: args });
const text = (r) => r.content[0].text;
const writes = () => api.log.filter((r) => r.method === "POST");

test("expone las 4 herramientas", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["sp_get", "sp_me", "sp_routes", "sp_write"]);
});

test("sp_me usa el token", async () => {
  const r = await call("sp_me");
  assert.equal(JSON.parse(text(r)).username, "tester@example.com");
  assert.equal(api.log.at(-1).auth, `Bearer ${TEST_TOKEN}`);
});

test("sp_get lee de la empresa por defecto y de otra empresa", async () => {
  assert.equal(JSON.parse(text(await call("sp_get", { path: "/api/admin/accounts" })))[0].name, "SAT");
  const bodas = JSON.parse(text(await call("sp_get", { path: "/api/admin/accounts", company: "bodad" })));
  assert.equal(bodas[0].name, "Caja bodas");
  assert.equal(api.log.at(-1).tenant, "bodad");
});

test("sp_write sin confirm sólo da vista previa y no envía nada", async () => {
  const before = writes().length;
  const r = await call("sp_write", { path: "/api/admin/accounts", body: { name: "Prueba" } });
  assert.match(text(r), /VISTA PREVIA/);
  assert.equal(writes().length, before);
});

test("crear, actualizar y borrar con confirm=true", async () => {
  const created = JSON.parse(
    text(
      await call("sp_write", {
        path: "/api/admin/accounts",
        body: { name: "Banco prueba", account_type: "bank", currency: "MXN" },
        confirm: true,
      })
    )
  );
  assert.ok(api.db.sp.find((a) => a.id === created.id));

  await call("sp_write", {
    path: `/api/admin/accounts/${created.id}/update`,
    body: { name: "Banco renombrado", account_type: "bank", currency: "MXN" },
    confirm: true,
  });
  assert.equal(api.db.sp.find((a) => a.id === created.id).name, "Banco renombrado");

  await call("sp_write", { path: `/api/admin/accounts/${created.id}/delete`, confirm: true });
  assert.equal(api.db.sp.find((a) => a.id === created.id), undefined);
  assert.equal(api.db.bodad.length, 1, "la otra empresa no se tocó");
});

test("errores del servidor se reportan como error", async () => {
  const r = await call("sp_write", { path: "/api/admin/accounts", body: {}, confirm: true });
  assert.equal(r.isError, true);
  assert.match(text(r), /HTTP 400/);
});

test("rutas bloqueadas no salen a la red", async () => {
  const before = api.log.length;
  for (const path of [
    "/api/admin/companies/x/transactions/delete_all",
    "/api/admin/companies/x/delete",
    "/api/account/tokens",
    "/api/admin/sat-configs/upload",
  ]) {
    const r = await call("sp_write", { path, confirm: true });
    assert.equal(r.isError, true, path);
    assert.match(text(r), /Bloqueado/);
  }
  assert.equal(api.log.length, before);
});

test("rutas fuera del catálogo se rechazan", async () => {
  const r = await call("sp_get", { path: "/api/admin/nada" });
  assert.equal(r.isError, true);
});

test("oculta secretos en las respuestas", async () => {
  const r = await call("sp_get", { path: "/api/admin/users/u1" });
  assert.equal(JSON.parse(text(r)).secret, "[oculto]");
  assert.doesNotMatch(text(r), /JBSWY3DPEHPK3PXP/);
});

test("slug de empresa inválido se rechaza", async () => {
  const r = await call("sp_get", { path: "/api/admin/accounts", company: "evil.com/x" });
  assert.equal(r.isError, true);
});
