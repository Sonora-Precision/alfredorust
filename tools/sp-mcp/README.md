# sp-mcp — conector de Claude para la plataforma

Conector MCP en Node que deja a Claude leer y (con confirmación) modificar los
datos de la plataforma usando un **token de acceso personal**. No se compila:
es un solo archivo, [`server.mjs`](server.mjs), que se edita directamente.

## Instalación (una vez por equipo)

1. En la app: **Mi cuenta → Tokens de acceso** → crear token y copiarlo.
2. Guardarlo como variable de entorno de usuario (PowerShell, con el token en el portapapeles):

   ```powershell
   $t = (Get-Clipboard -Raw).Trim(); if ($t -match '^spat_\S+$') { [Environment]::SetEnvironmentVariable('SPCLI_TOKEN', $t, 'User'); Set-Clipboard -Value ' '; 'OK' } else { 'ERROR: no es un token spat_' }; Remove-Variable t
   ```

   macOS/Linux: `export SPCLI_TOKEN=spat_...` en `~/.zshrc` / `~/.bashrc`.
3. Instalar dependencias y probar:

   ```bash
   cd tools/sp-mcp && npm install && npm run check
   ```

4. Abrir Claude Code en la raíz del repo: el archivo `.mcp.json` registra el
   conector `sonora-platform` (Claude pide aprobarlo la primera vez).

## Herramientas

| Herramienta | Qué hace |
| --- | --- |
| `sp_me` | Usuario, rol y empresas del token |
| `sp_routes` | Catálogo de rutas de la API (filtrable) |
| `sp_get` | Lectura (GET) de cualquier ruta del catálogo |
| `sp_write` | Escritura (POST). Sin `confirm: true` sólo muestra una vista previa |

## Seguridad

- El token sólo se lee de `SPCLI_TOKEN` (en Windows también del registro de usuario); nunca se imprime.
- Las respuestas ocultan campos sensibles (`secret`, `password`, `token`, …).
- Bloqueado en el conector (se hace en la web): borrados masivos, borrar empresa,
  cuenta/tokens/TOTP y subidas de archivos.
- Cada token respeta los permisos y empresas del usuario que lo creó; se revoca desde **Mi cuenta**.

## Pruebas (sin tocar producción)

```bash
npm test
```

Levanta una API falsa en memoria (`test/mock-api.mjs`) con un token de prueba y
prueba lecturas, vista previa, crear/actualizar/borrar, rutas bloqueadas,
ocultamiento de secretos y aislamiento entre empresas. Para apuntar el conector a
un backend local (`cargo run`), usa `SP_API_ORIGIN=http://localhost:8090`.

## Configuración opcional

| Variable | Default |
| --- | --- |
| `SP_COMPANY` | `sp` — empresa por defecto (slug del subdominio) |
| `SP_BASE_DOMAIN` | `alfredorivera.dev` |
| `SP_LOGIN_HOST` | `app` |
| `SP_API_ORIGIN` | _(vacío)_ — servidor local o de pruebas; la empresa va en el encabezado `Host` |

Para agregar una ruta nueva de la API, añádela al arreglo `ROUTES` en `server.mjs`.
