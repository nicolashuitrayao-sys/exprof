# exprof

Mini **SQL Server Profiler para la terminal**. Escucha en vivo las llamadas a un stored procedure (con sus argumentos y valores) sin necesitar SQL Server Profiler ni SSMS. Funciona en macOS, Linux y Windows.

Pensado para quien no tiene el Profiler clásico (por ejemplo en Mac) y necesita una solución rápida: un comando, un filtro, y ves qué le está llegando al SP.

```
$ exprof usp_ResumenVentas
env: /home/yo/exprof/.env · Escuchando en mi-servidor,1433 · filtro: usp_ResumenVentas · Ctrl+C para salir

10:39:05.090 RPC   sp_executesql dur=10.5ms cpu=9.0ms reads=1542 rows=1
  MiBase · spid 63 · app_user@host · mi-app
  exec sp_executesql @statement=N'EXEC dbo.usp_ResumenVentas @Id=@a',@params=N'@a int',@a=7
```

## Cómo funciona

Crea una sesión temporal de **Extended Events** en el servidor (el reemplazo moderno del Profiler, que está deprecado), con un filtro por nombre de SP, y lee los eventos cada segundo. Al salir con Ctrl+C elimina la sesión. No modifica datos ni objetos de tus bases.

## Requisitos

- Node.js 18 o superior.
- SQL Server 2012+ (on-prem, VM, Express, Docker) o Azure SQL Managed Instance.
  **Azure SQL Database no está soportado** (usa sesiones a nivel de base de datos).
- Autenticación SQL (usuario y clave). Windows auth no está soportada.
- Un login con estos permisos:

```sql
GRANT ALTER ANY EVENT SESSION TO [mi_login];
GRANT VIEW SERVER STATE TO [mi_login];
```

## Instalación

```bash
git clone <url-de-este-repo> exprof
cd exprof
npm install
npm link        # deja el comando `exprof` disponible globalmente
```

## Configuración

Copia el ejemplo y completa tus datos:

```bash
cp .env.example .env
chmod 600 .env
```

```env
EXPROF_SERVER=mi-servidor.ejemplo.local,1433
EXPROF_USER=mi_login
EXPROF_PASSWORD=CAMBIAR
EXPROF_DATABASE=master
```

`exprof` busca el `.env` en este orden (usa el primero que exista, y las variables ya exportadas en tu shell tienen prioridad):

1. Ruta indicada en `EXPROF_ENV`
2. `./.env` (carpeta actual)
3. `~/.exprof.env`
4. `.env` en la carpeta del proyecto

La clave solo se lee desde el `.env` o el entorno, nunca desde un flag, para que no quede en el historial del shell.

## Uso

```bash
exprof usp_MiProc                      # escucha un SP (coincidencia por substring, sin distinguir mayúsculas)
exprof usp_Pago usp_Contrato           # varios SP a la vez
exprof 'usp_Pago%' -d MiBase           # comodín LIKE (si incluyes %) y solo esa base
exprof usp_MiProc --show-source        # además, muestra el código del SP sentencia a sentencia
exprof usp_MiProc --errors --min-ms 500  # solo errores o ejecuciones lentas
exprof usp_MiProc --json               # una línea JSON por evento
exprof --all -d MiBase --app mi-app    # todo el tráfico RPC (para diagnosticar)
exprof --clean                         # borra sesiones exprof_* huérfanas y sale
```

| Opción | Descripción |
|---|---|
| `sp ...` / `-f, --sp` | Nombres o patrones de SP (repetible). |
| `-a, --all` | Sin filtro de SP. Ojo con servidores muy cargados. |
| `-d, --db` | Solo esta base de datos. |
| `--app <patron>` | Filtra por nombre de aplicación cliente. |
| `--login <patron>` | Filtra por login. |
| `--min-ms <n>` | Solo ejecuciones con duración ≥ n ms. |
| `--errors` | Solo RPC abortados y errores reportados (severidad > 10, incluye `RAISERROR`). |
| `--show-source` | Muestra las sentencias internas del SP, con nivel de anidamiento y línea (alias: `--statements`). |
| `--no-batches` | No incluir `EXEC` enviados como batch de texto (solo RPC). |
| `-S`, `-U` | Sobrescriben servidor y usuario del `.env`. |
| `--encrypt` | Valida el certificado TLS (por defecto confía en el del servidor). |
| `--redact` | Oculta los valores de los parámetros (`?`) y deja solo la estructura de la llamada. Best-effort. |
| `--for <seg>` / `--max <n>` | Termina solo tras `<seg>` segundos o `<n>` eventos (limpia la sesión). |
| `--json` | Salida en JSON. |
| `--interval <ms>` | Frecuencia de lectura (por defecto 1000). |

Por defecto se muestra **la llamada** al SP con sus parámetros, tanto si llega por RPC como por `EXEC` en un batch. Si tu app usa un ORM o driver que envuelve la llamada en `sp_executesql`, también se captura: el filtro busca el nombre del SP tanto en el objeto como en el texto de la llamada.

### Si no ves nada

- Si el SP lo llama **otro SP**, no hay una llamada externa: usa `--show-source` para ver las sentencias internas y los SP anidados.
- Confirma que la app está conectada al **mismo servidor** que tu `.env` (réplicas, ambientes, balanceadores).
- Prueba con un trozo del nombre, o con `--all -d <base> --app <app>` para ver cómo llega la llamada.
- Los mensajes `poll:` o de permisos aparecen en la terminal; revisa que el login tenga los dos permisos.

## Uso con agentes de IA (Claude Code)

`exprof` está pensado para poder correrlo desde un agente: `--for`/`--max` hacen que termine solo, `--json` entrega eventos parseables y `--redact` evita exponer valores reales de parámetros.

```bash
exprof usp_MiProc --redact --for 20 --json > /tmp/exprof.log &   # dispara la acción y luego lee el log
```

El repo incluye una skill de Claude Code en [`skills/exprof/SKILL.md`](skills/exprof/SKILL.md). Para instalarla:

```bash
mkdir -p ~/.claude/skills/exprof && cp skills/exprof/SKILL.md ~/.claude/skills/exprof/
```

La skill indica al agente cuándo usar `--redact`, que no lea credenciales y cómo interpretar la salida.

## Probarlo localmente con Docker

En `testenv/` hay un SQL Server 2022 de ejemplo con una base, SPs de prueba y un servicio que los llama cada 5 segundos:

```bash
docker compose -f testenv/docker-compose.yml up -d
sqlcmd -S localhost,14330 -U sa -P 'Exprof_Sa#2026' -C -i testenv/init.sql   # crea base, SPs y usuarios de ejemplo
node testenv/service.js                                                      # en otra terminal
EXPROF_ENV=testenv/.env.docker exprof usp_ResumenVentas --show-source        # en una tercera
```

Las credenciales de `testenv/` son solo para ese contenedor local desechable.

## Limitaciones

- El ring buffer es de 4 MB: en servidores con muchísimo tráfico y sin filtro específico pueden perderse eventos.
- Un `RAISERROR` no marca el RPC como fallido; por eso `--errors` los captura aparte (esos eventos no incluyen el nombre del SP).
- Cada consulta lee el buffer completo, así que conviene no usar `--interval` demasiado bajo.

## Seguridad y privacidad

- Los eventos incluyen **los valores de los parámetros**, que pueden ser datos personales o sensibles. Úsalo solo en entornos donde tengas autorización, usa `--redact` cuando la salida vaya a compartirse o a un agente de IA, y no la compartas sin revisarla (la redacción es best-effort).
- Nunca subas tu `.env` al repositorio (ya está en `.gitignore`).
- Usa un login dedicado con los permisos mínimos indicados arriba.

## Licencia

MIT. Ver [LICENSE](LICENSE).
