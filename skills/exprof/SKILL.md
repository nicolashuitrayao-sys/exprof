---
name: exprof
description: Captura en vivo las llamadas a un stored procedure de SQL Server (con argumentos y valores) usando la herramienta de terminal `exprof`, para testear o depurar qué recibe un SP cuando se dispara una acción (API, test, página). Usar cuando el usuario pida "ver qué llega al SP", "escuchar/perfilar un procedimiento", "qué parámetros manda la app" o validar que un cambio dispara el SP esperado. Reemplazo de SQL Server Profiler en macOS/Linux.
---

# exprof: escuchar stored procedures de SQL Server

`exprof` crea una sesión temporal de Extended Events filtrada por nombre de SP y muestra cada llamada con sus argumentos. Al terminar borra la sesión.

## Reglas de seguridad (leer primero)

1. **Datos sensibles.** La salida entra al contexto de la conversación. Los valores de parámetros pueden ser RUT, montos, correos, teléfonos, etc.
   - Contra el Docker de pruebas (`testenv/.env.docker`, datos ficticios): se puede usar sin `--redact`.
   - Contra **cualquier otro servidor** (staging/producción/datos reales): usar **siempre `--redact`**, salvo que el usuario indique explícitamente lo contrario para este caso.
2. **No leer ni imprimir el `.env` ni credenciales.** `exprof` ya las carga solo. Para verificar que existe, solo confirmar que el archivo está, sin mostrar su contenido.
3. **No conectar a un servidor real sin confirmación del usuario** en esta conversación. Si un permiso es denegado, no buscar rodeos: explicar qué se intentaba y dejar que el usuario lo ejecute en su terminal.
4. No pegar la salida en herramientas externas (tickets, chats, issues) sin anonimizarla. Si el usuario la comparte con datos reales, avisar brevemente que es confidencial.

## Comando base

```bash
exprof <sp> [<sp2> ...] --redact --for <seg> --json > "$LOG" 2>&1 &
```

- `--for <seg>` / `--max <n>`: **siempre** poner uno, así termina solo y borra su sesión (no hace falta `kill`).
- Sin `--for`/`--max`/`--json` y en una terminal, `exprof` abre una **interfaz interactiva** pensada para personas: no usarla desde el agente. Si el usuario quiere explorar a mano, sugerirle `exprof` (o `exprof <sp>`) en su propia terminal.
- `--json`: una línea JSON por evento (campos: `time`, `event`, `db`, `sp`, `spid`, `login`, `host`, `app`, `duration_ms`, `cpu_ms`, `reads`, `rows`, `result`, `text`). Sin `--json` la salida es legible para humanos.
- Sin `--redact` solo si aplica la regla 1.
- El nombre del SP es substring sin distinguir mayúsculas; con `%` se usa como LIKE.

## Flujo para testear un disparo

1. Confirmar contra qué servidor apunta (`.env` / `EXPROF_ENV`; el Docker de pruebas usa `EXPROF_ENV=testenv/.env.docker`).
2. Lanzar `exprof` en segundo plano con `--for` (ej. 20–30 s) escribiendo a un log en el scratchpad, no en el repo.
3. **Esperar ~3 s** a que aparezca "Escuchando en ..." en el log (la sesión debe estar activa antes del disparo).
4. Disparar la acción (llamada a la API, test, `sqlcmd`, o pedirle al usuario que cargue la página).
5. Esperar a que termine `--for` (o `--max`), leer el log y resumir: qué SP, con qué estructura de llamada, duración, filas, errores.
6. Si quedó una sesión huérfana (proceso cortado): `exprof --clean`.

## Interpretar resultados

- `RPC` = llamada directa. Los ORMs/drivers la envuelven en `sp_executesql`: el SP aparece dentro de `text`, los valores al final (`@a=...`; con `--redact` salen `?`).
- `BATCH` = `EXEC ...` enviado como texto.
- `STMT` (solo con `--show-source`) = cada sentencia interna del SP, con `nest` (anidamiento) y `line`.
- `ERR` = error reportado (solo con `--errors`, severidad > 10; incluye `RAISERROR`). No trae el nombre del SP.
- **No sale nada:**
  - el SP puede ser llamado por otro SP → reintentar con `--show-source`;
  - la app puede apuntar a otro servidor/base que el `.env`;
  - probar con un trozo del nombre, o `--all -d <base> --app <app> --redact` acotado a pocos segundos para ver cómo llega la llamada;
  - revisar mensajes `poll:`/permisos (el login necesita `ALTER ANY EVENT SESSION` y `VIEW SERVER STATE`).

## Opciones útiles

| Opción | Uso |
|---|---|
| `-d <base>` | Solo esa base de datos |
| `--app <p>` / `--login <p>` | Filtrar por aplicación o login |
| `--min-ms <n>` | Solo ejecuciones ≥ n ms (buscar lentos) |
| `--errors` | Solo RPC abortados + errores reportados |
| `--show-source` | Además, código del SP sentencia a sentencia |
| `--no-batches` | Solo RPC, sin `EXEC` en batch |
| `--all` | Sin filtro de SP (acotar con `-d`, `--app` y `--for`; no en servidores cargados) |

## Probar en local

```bash
docker compose -f testenv/docker-compose.yml up -d
sqlcmd -S localhost,14330 -U sa -P 'Exprof_Sa#2026' -C -i testenv/init.sql
node testenv/service.js &        # llama SPs cada 5 s
EXPROF_ENV=testenv/.env.docker exprof usp_ResumenVentas --for 15
```

## Limitaciones

Ring buffer de 4 MB (sin filtro específico en servidores cargados pueden perderse eventos). `--redact` es best-effort: revisar antes de compartir. Solo autenticación SQL. No soporta Azure SQL Database.
