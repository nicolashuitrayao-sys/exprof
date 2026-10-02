# exprof

Mini **SQL Server Profiler para la terminal**. Escucha en vivo las llamadas a un stored procedure (con sus argumentos, tipos y valores) sin necesitar SQL Server Profiler ni SSMS. Funciona en macOS, Linux y Windows.

Pensado para quien no tiene el Profiler clásico (por ejemplo en Mac) y necesita una solución rápida: abres `exprof`, defines el filtro y ves qué le está llegando al SP.

```
 ◆ exprof  mini SQL Server Profiler                                                   ● CAPTURANDO 00:42
╭─ Conexión ──────────────────────────────────────────────────────────────────────── env: .env ─╮
│ Cadena     Server=mi-servidor,1433;Database=master;User Id=app_lectura;Password=••••••••;…     │
│ Usuario    app_lectura                                     Contraseña •••••••• .env [p] cambiar │
│ Servidor   SQLPROD01 · Microsoft SQL Server 2022 16.0.4295.3 · Standard Edition    [e] editar │
│ Filtro     SP: usp_Pedido · base: Ventas                                          [f] editar │
╰─────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ SPs ejecutados · 3 ─────────────────────────────────────────────── ▲ siguiendo lo más reciente ─╮
│   HORA         VÍA   SP                         ARGUMENTOS                  DURACIÓN  FILAS  ESTADO │
│ ▸ 10:39:05.090 RPC   dbo.usp_RegistrarPedido    @ClienteId=2, @Monto=1234…  21.4 ms   1      OK     │
│   10:39:04.871 BATCH dbo.usp_CalcularTotal      @ClienteId=1, @Total=@t     4.1 ms    2      OK     │
╰─────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ Detalle ───────────────────────────────────────────────────────────────────────────── RPC ─╮
│ dbo.usp_RegistrarPedido  Ventas · spid 63 · app@mi-pc · mi-app                              │
│ PARÁMETRO   TIPO           ORIGEN     VALOR                                                 │
│ @ClienteId  int            declarado  2                                                     │
│ @Monto      decimal(12,2)  declarado  1234.50                                               │
│ RAW tal como llegó al servidor  [c] copiar                                                  │
│ exec sp_executesql N'EXEC dbo.usp_RegistrarPedido @ClienteId=@p0, @Monto=@p1',N'@p0 int,…   │
│ EXEC listo para SSMS / Azure Data Studio  [y] copiar                                        │
│ USE [Ventas];                                                                               │
│ EXEC dbo.usp_RegistrarPedido @ClienteId = 2, @Monto = 1234.50;                              │
╰─────────────────────────────────────────────────────────────────────────────────────────────╯
╭─ Actividad ─────────────────────────────────────────────────────────────────────────────────╮
│ 10:38:51 ✓ Captura iniciada · sesión exprof_4211_murdm2kn · SP: usp_Pedido · base: Ventas   │
╰─────────────────────────────────────────────────────────────────────────────────────────────╯
s detener  ↑↓ navegar  c copiar raw  y copiar EXEC  p contraseña  f filtro  r redactar  ? ayuda  q salir
```

Para scripts y agentes de IA sigue existiendo el modo de texto (`--json`, `--for`, `--max`, `--plain`).

## Cómo funciona

Crea una sesión temporal de **Extended Events** en el servidor (el reemplazo moderno del Profiler, que está deprecado), con un filtro por nombre de SP, y lee los eventos cada segundo. Al salir con Ctrl+C elimina la sesión. No modifica datos ni objetos de tus bases.

## Requisitos

- Node.js 22 o superior.
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

# Opcionales
EXPROF_FILTER=usp_Pago,usp_Contrato   # SPs por defecto (la TUI los precarga en el filtro)
EXPROF_REDACT=1                       # ocultar valores por defecto (recomendado con datos reales)
EXPROF_ENCRYPT=1                      # validar el certificado TLS
```

`exprof` busca el `.env` en este orden (usa el primero que exista, y las variables ya exportadas en tu shell tienen prioridad):

1. Ruta indicada en `EXPROF_ENV`
2. `./.env` (carpeta actual)
3. `~/.exprof.env`
4. `.env` en la carpeta del proyecto

La clave solo se lee desde el `.env` o el entorno, nunca desde un flag, para que no quede en el historial del shell. En la interfaz se puede cambiar para la sesión actual (`p`), pero ese valor vive solo en memoria.

## Interfaz interactiva

```bash
exprof                       # abre la interfaz; define el filtro con [f] e inicia con [s]
exprof usp_MiProc -d MiBase  # abre la interfaz con el filtro puesto y la captura iniciada
```

En una terminal interactiva `exprof` abre una interfaz a pantalla completa con:

- **Conexión**: cadena de conexión actual (con la clave enmascarada), usuario, origen de la clave (`.env` o manual), servidor y versión, filtro activo.
- **SPs ejecutados**: hora, vía (`RPC`, `BATCH`), nombre, argumentos, duración, filas y estado. Lo más reciente arriba.
- **Detalle** del SP seleccionado: cada parámetro con su **tipo** y de dónde salió, la llamada **raw** tal como llegó al servidor y una versión **EXEC** lista para pegar en SSMS / Azure Data Studio (desenvuelve `sp_executesql` y declara las variables `OUTPUT`).
- **Actividad**: conexión, inicio/detención de la captura, errores de conexión o permisos, copias al portapapeles.

| Tecla | Acción |
|---|---|
| `s` / espacio | Iniciar o detener la captura (crea o elimina la sesión de Extended Events) |
| `↑` `↓` / `j` `k`, `PgUp` `PgDn` | Navegar por los SPs capturados |
| `g` | Volver a seguir lo más reciente |
| `c` / `y` | Copiar la llamada raw / la versión EXEC limpia |
| `p` | Cambiar la contraseña de la conexión (solo en memoria; `Ctrl+R` vuelve a la del `.env`) |
| `e` | Editar servidor, base y usuario |
| `f` | Editar el filtro: SPs (`*` = todos), base, aplicación, login, duración mínima |
| `r` | Redactar valores en pantalla y al copiar |
| `x` | Limpiar la lista |
| `o` | Eliminar sesiones `exprof_*` huérfanas |
| `?` | Ayuda |
| `q` / `Ctrl+C` | Salir (elimina la sesión del servidor) |

**Tipos de los parámetros.** La columna *ORIGEN* indica de dónde sale cada tipo:

- `catálogo`: el tipo declarado en el SP (`sys.parameters`). Requiere que el login tenga acceso a esa base y `VIEW DEFINITION` (opcional: `GRANT VIEW DEFINITION TO [mi_login]` en la base). También nombra los argumentos que se pasaron por posición.
- `declarado`: el que declaró el cliente en `sp_executesql` (ORMs/drivers) o con `DECLARE` en el batch.
- `inferido`: deducido del valor (`N'..'` → nvarchar, `12.5` → decimal, etc.). Es aproximado.

Copiar usa `pbcopy` (macOS), `clip` (Windows), `wl-copy`/`xclip`/`xsel` (Linux) o, si no hay ninguno, la secuencia OSC 52 de la terminal.

## Modo texto (scripts y agentes)

Se usa automáticamente con `--json`, `--for`, `--max` o `--plain`, o cuando la salida no es una terminal (redirigida a un archivo o a un pipe).

```bash
exprof usp_MiProc --plain              # escucha un SP (coincidencia por substring, sin distinguir mayúsculas)
exprof usp_Pago usp_Contrato --plain   # varios SP a la vez
exprof 'usp_Pago%' -d MiBase --plain   # comodín LIKE (si incluyes %) y solo esa base
exprof usp_MiProc --show-source --plain  # además, muestra el código del SP sentencia a sentencia
exprof usp_MiProc --errors --min-ms 500 --plain  # solo errores o ejecuciones lentas
exprof usp_MiProc --json               # una línea JSON por evento
exprof --all -d MiBase --app mi-app --plain  # todo el tráfico RPC (para diagnosticar)
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
| `--redact` / `--no-redact` | Oculta los valores de los parámetros (`?`) y deja solo la estructura de la llamada (best-effort). `--no-redact` ignora `EXPROF_REDACT=1`. |
| `--for <seg>` / `--max <n>` | Termina solo tras `<seg>` segundos o `<n>` eventos (limpia la sesión). |
| `--json` | Salida en JSON. |
| `--interval <ms>` | Frecuencia de lectura (por defecto 1000). |
| `--plain` / `--tui` | Fuerza el modo de texto o la interfaz interactiva. |

Por defecto se muestra **la llamada** al SP con sus parámetros, tanto si llega por RPC como por `EXEC` en un batch. Si tu app usa un ORM o driver que envuelve la llamada en `sp_executesql`, también se captura: el filtro busca el nombre del SP tanto en el objeto como en el texto de la llamada.

### Si no ves nada

- Si el SP lo llama **otro SP**, no hay una llamada externa: usa `--show-source` para ver las sentencias internas y los SP anidados.
- Confirma que la app está conectada al **mismo servidor** que tu `.env` (réplicas, ambientes, balanceadores).
- Prueba con un trozo del nombre, o con `--all -d <base> --app <app>` para ver cómo llega la llamada.
- Los mensajes `poll:` o de permisos aparecen en la terminal; revisa que el login tenga los dos permisos.

## Uso con agentes de IA (Claude Code)

`exprof` está pensado para poder correrlo desde un agente: `--for`/`--max` hacen que termine solo, `--json` entrega eventos parseables y `--redact` evita exponer valores reales de parámetros. Con esas opciones (o sin terminal) nunca se abre la interfaz interactiva.

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
EXPROF_ENV=testenv/.env.docker exprof usp_                                   # interfaz, en una tercera
EXPROF_ENV=testenv/.env.docker exprof usp_ResumenVentas --show-source --plain  # o modo texto
```

Las credenciales de `testenv/` son solo para ese contenedor local desechable. `init.sql` también da `VIEW DEFINITION` a `exprof_user` para que la interfaz muestre los tipos desde el catálogo.

Tests unitarios del parser de llamadas y la redacción: `npm test`.

## Limitaciones

- El ring buffer es de 4 MB: en servidores con muchísimo tráfico y sin filtro específico pueden perderse eventos.
- Un `RAISERROR` no marca el RPC como fallido; por eso `--errors` los captura aparte (esos eventos no incluyen el nombre del SP).
- Cada consulta lee el buffer completo, así que conviene no usar `--interval` demasiado bajo.

## Seguridad y privacidad

- Los eventos incluyen **los valores de los parámetros**, que pueden ser datos personales o sensibles. Úsalo solo en entornos donde tengas autorización, usa `--redact` cuando la salida vaya a compartirse o a un agente de IA, y no la compartas sin revisarla (la redacción es best-effort).
- Nunca subas tu `.env` al repositorio (ya está en `.gitignore`).
- Usa un login dedicado con los permisos mínimos indicados arriba.
- La interfaz nunca muestra la clave (ni su largo): la cadena de conexión aparece con `Password=••••••••`. Si la cambias con `p`, se usa solo en memoria y no se escribe en disco. Tras leerla, se elimina de las variables de entorno del proceso para que no la hereden procesos hijos.
- Los eventos capturados se guardan solo en memoria (máximo 1000) y la interfaz usa la pantalla alternativa de la terminal: al salir no quedan valores en el scrollback.
- Con `EXPROF_REDACT=1` la redacción queda activa por defecto; en la interfaz se alterna con `r` y aplica también a lo que se copia.

## Licencia

MIT. Ver [LICENSE](LICENSE).
