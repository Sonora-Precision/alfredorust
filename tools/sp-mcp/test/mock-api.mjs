// Servidor falso que imita la API de la plataforma, en memoria.
// Sirve para probar el conector sin tocar producción.
import http from "node:http";

export const TEST_TOKEN = "spat_test_0000000000000000";

export function startMockApi() {
  const log = [];
  const db = {
    sp: [{ id: "a1", name: "SAT", account_type: "other", currency: "MXN", is_active: true }],
    bodad: [{ id: "b1", name: "Caja bodas", account_type: "cash", currency: "MXN", is_active: true }],
  };
  let seq = 100;

  const server = http.createServer(async (req, res) => {
    const host = (req.headers.host || "").split(":")[0];
    const tenant = host.split(".")[0];
    const { pathname } = new URL(req.url, "http://x");
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    log.push({ method: req.method, tenant, path: pathname, body, auth: req.headers.authorization });

    const json = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };

    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) return json(401, { error: "unauthorized" });

    if (req.method === "GET" && pathname === "/api/me") {
      return json(200, {
        username: "tester@example.com",
        role: "admin",
        company_slug: "sp",
        companies: [{ slug: "sp" }, { slug: "bodad" }],
      });
    }
    if (req.method === "GET" && pathname === "/api/admin/users/u1") {
      return json(200, { id: "u1", username: "tester@example.com", secret: "JBSWY3DPEHPK3PXP" });
    }

    const accounts = db[tenant];
    if (accounts) {
      let m;
      if (pathname === "/api/admin/accounts" && req.method === "GET") return json(200, accounts);
      if (pathname === "/api/admin/accounts" && req.method === "POST") {
        if (!body?.name) return json(400, { error: "name is required" });
        const id = `n${seq++}`;
        accounts.push({ id, ...body });
        return json(200, { id });
      }
      if ((m = pathname.match(/^\/api\/admin\/accounts\/([^/]+)$/)) && req.method === "GET") {
        const a = accounts.find((x) => x.id === m[1]);
        return a ? json(200, a) : json(404, { error: "not found" });
      }
      if ((m = pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/update$/)) && req.method === "POST") {
        const i = accounts.findIndex((x) => x.id === m[1]);
        if (i < 0) return json(404, { error: "not found" });
        accounts[i] = { id: m[1], ...body };
        return json(200, { ok: true });
      }
      if ((m = pathname.match(/^\/api\/admin\/accounts\/([^/]+)\/delete$/)) && req.method === "POST") {
        const i = accounts.findIndex((x) => x.id === m[1]);
        if (i < 0) return json(404, { error: "not found" });
        accounts.splice(i, 1);
        return json(200, { ok: true });
      }
    }

    // Como el servidor real: rutas desconocidas regresan la SPA.
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html></html>");
  });

  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({ origin: `http://127.0.0.1:${server.address().port}`, log, db, close: () => server.close() })
    )
  );
}
