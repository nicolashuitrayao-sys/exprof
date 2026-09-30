#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseArgs } = require('util');
const sql = require('mssql');

const HELP = `exprof - mini SQL Server Profiler (Extended Events) para terminal

Uso:
  exprof [opciones] [sp ...]

Filtro de SP (obligatorio salvo --all):
  sp ...                  Nombres/patrones de SP. Substring por defecto; si incluyes % se usa como LIKE exacto.
  -f, --sp <patron>       Igual que arriba (repetible)
  -a, --all               Sin filtro de SP (todo RPC)

Filtros extra:
  -d, --db <nombre>       Solo esta base de datos
      --app <patron>      Filtra por client_app_name
      --login <patron>    Filtra por login
      --min-ms <n>        Solo duracion >= n ms
      --errors            Solo RPC abortados + errores reportados (severity>10, RAISERROR incluido)
      --show-source       Ademas de la llamada, muestra el codigo del SP sentencia a sentencia
                          (con nivel de anidamiento y linea). Alias: --statements
      --no-batches        No incluir EXEC enviados como batch de texto (solo RPC)

Por defecto muestra cada llamada al SP con sus argumentos y valores (RPC y EXEC por batch).

Conexion (archivo .env; ver .env.example):
  Se busca en: $EXPROF_ENV, ./.env, ~/.exprof.env, <carpeta de exprof>/.env
  EXPROF_SERVER (host[,puerto]) · EXPROF_USER · EXPROF_PASSWORD · EXPROF_DATABASE
  -S, --server <host[,puerto]>   Sobrescribe EXPROF_SERVER
  -U, --user <login>             Sobrescribe EXPROF_USER (Windows auth no disponible en macOS)
      --encrypt                  Valida el certificado TLS (por defecto confia en el del servidor)

Salida:
      --json              Una linea JSON por evento
      --interval <ms>     Frecuencia de polling (def. 1000)
      --clean             Elimina sesiones exprof_* huerfanas y sale
  -h, --help

Requiere permiso ALTER ANY EVENT SESSION + VIEW SERVER STATE.
`;

let opts, positionals;
try {
  ({ values: opts, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      sp: { type: 'string', short: 'f', multiple: true },
      all: { type: 'boolean', short: 'a' },
      db: { type: 'string', short: 'd' },
      app: { type: 'string' },
      login: { type: 'string' },
      'min-ms': { type: 'string' },
      errors: { type: 'boolean' },
      'show-source': { type: 'boolean' },
      statements: { type: 'boolean' }, // alias de --show-source
      'no-batches': { type: 'boolean' },
      server: { type: 'string', short: 'S' },
      user: { type: 'string', short: 'U' },
      encrypt: { type: 'boolean' },
      json: { type: 'boolean' },
      interval: { type: 'string' },
      clean: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  }));
} catch (e) {
  console.error(e.message + '\n\n' + HELP);
  process.exit(2);
}
if (opts.statements) opts['show-source'] = true;
if (opts.help) { console.log(HELP); process.exit(0); }

// ---------- config (.env) ----------
// Prioridad: variables ya exportadas > EXPROF_ENV > ./.env > ~/.exprof.env > <carpeta de exprof>/.env
function loadDotenv(file) {
  if (!fs.existsSync(file)) return false;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || m[1] === undefined) continue;
    let v = m[2];
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
  return true;
}
const envFiles = [process.env.EXPROF_ENV, path.join(process.cwd(), '.env'), path.join(os.homedir(), '.exprof.env'), path.join(__dirname, '..', '.env')].filter(Boolean);
if (process.env.EXPROF_ENV && !fs.existsSync(process.env.EXPROF_ENV)) {
  console.error(`EXPROF_ENV apunta a un archivo que no existe: ${process.env.EXPROF_ENV}`);
  process.exit(2);
}
const usedEnv = envFiles.filter(loadDotenv);
const cfg = {
  server: opts.server || process.env.EXPROF_SERVER || 'localhost',
  user: opts.user || process.env.EXPROF_USER,
  password: process.env.EXPROF_PASSWORD,
  database: process.env.EXPROF_DATABASE || 'master',
};
const [host, port] = cfg.server.split(',');
const pool = new sql.ConnectionPool({
  server: host,
  port: port ? Number(port) : undefined,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
  requestTimeout: 30000,
  options: { encrypt: true, trustServerCertificate: !opts.encrypt, enableArithAbort: true },
});

// ---------- helpers ----------
const lit = (s) => "N'" + String(s).replace(/'/g, "''") + "'";
const like = (col, pat) => {
  const p = pat.includes('%') ? pat : `%${pat}%`; // sin % -> substring; '_' matchea cualquier caracter (incluido '_')
  return `sqlserver.like_i_sql_unicode_string(${col}, ${lit(p)})`;
};
const C = process.stdout.isTTY && !process.env.NO_COLOR
  ? { d: '\x1b[2m', r: '\x1b[31m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', b: '\x1b[1m', x: '\x1b[0m' }
  : { d: '', r: '', g: '', y: '', c: '', b: '', x: '' };

const ACTIONS = `ACTION (sqlserver.database_name, sqlserver.client_app_name, sqlserver.client_hostname, sqlserver.username, sqlserver.session_id, package0.event_sequence)`;

function buildSession(name, patterns) {
  const common = [];
  if (opts.db) common.push(`sqlserver.database_name = ${lit(opts.db)}`);
  if (opts.app) common.push(like('sqlserver.client_app_name', opts.app));
  if (opts.login) common.push(like('sqlserver.username', opts.login));
  const minUs = opts['min-ms'] ? Math.round(Number(opts['min-ms']) * 1000) : 0;
  if (minUs > 0) common.push(`duration >= ${minUs}`);
  const spFilter = patterns.length ? '(' + patterns.map((p) => like('object_name', p)).join(' OR ') + ')' : null;

  const where = (extra) => {
    const parts = [...common, ...extra].filter(Boolean);
    return parts.length ? `WHERE (${parts.join(' AND ')})` : '';
  };
  // ORMs/drivers envuelven la llamada en sp_executesql/sp_prepexec: el SP solo aparece dentro del texto (statement)
  const rpcSp = patterns.length ? '(' + patterns.map((p) => `${like('object_name', p)} OR ${like('statement', p)}`).join(' OR ') + ')' : null;
  const rpcExtra = [rpcSp, opts.errors ? 'result <> 0' : null];
  const events = [`ADD EVENT sqlserver.rpc_completed (SET collect_statement=(1) ${ACTIONS} ${where(rpcExtra)})`];
  if (opts['show-source']) {
    events.push(`ADD EVENT sqlserver.sp_statement_completed (SET collect_object_name=(1), collect_statement=(1) ${ACTIONS} ${where([spFilter])})`);
  }
  if (!opts['no-batches'] && patterns.length) {
    const b = '(' + patterns.map((p) => like('batch_text', p)).join(' OR ') + ')';
    events.push(`ADD EVENT sqlserver.sql_batch_completed (${ACTIONS} ${where([b, opts.errors ? 'result <> 0' : null])})`);
  }
  if (opts.errors) {
    const ec = [...common.filter((c) => !c.startsWith('duration')), 'severity > 10'];
    events.push(`ADD EVENT sqlserver.error_reported (${ACTIONS} WHERE (${ec.join(' AND ')}))`);
  }
  return `CREATE EVENT SESSION [${name}] ON SERVER
${events.join(',\n')}
ADD TARGET package0.ring_buffer (SET max_memory = 4096)
WITH (MAX_DISPATCH_LATENCY = 1 SECONDS, EVENT_RETENTION_MODE = ALLOW_SINGLE_EVENT_LOSS, STARTUP_STATE = OFF);`;
}

const READ_SQL = `
SELECT * FROM (
  SELECT
    x.e.value('(@name)[1]','nvarchar(60)') AS event,
    x.e.value('(@timestamp)[1]','datetime2(3)') AS ts,
    x.e.value('(action[@name="event_sequence"]/value)[1]','bigint') AS seq,
    x.e.value('(data[@name="object_name"]/value)[1]','nvarchar(400)') AS obj,
    x.e.value('(data[@name="statement"]/value)[1]','nvarchar(max)') AS stmt,
    x.e.value('(data[@name="batch_text"]/value)[1]','nvarchar(max)') AS batch,
    x.e.value('(data[@name="duration"]/value)[1]','bigint') AS duration_us,
    x.e.value('(data[@name="cpu_time"]/value)[1]','bigint') AS cpu_us,
    x.e.value('(data[@name="logical_reads"]/value)[1]','bigint') AS reads,
    x.e.value('(data[@name="writes"]/value)[1]','bigint') AS writes,
    x.e.value('(data[@name="row_count"]/value)[1]','bigint') AS rows,
    x.e.value('(data[@name="result"]/text)[1]','nvarchar(30)') AS result,
    x.e.value('(data[@name="nest_level"]/value)[1]','int') AS nest,
    x.e.value('(data[@name="line_number"]/value)[1]','int') AS line,
    x.e.value('(data[@name="message"]/value)[1]','nvarchar(max)') AS msg,
    x.e.value('(data[@name="error_number"]/value)[1]','int') AS errno,
    x.e.value('(data[@name="severity"]/value)[1]','int') AS sev,
    x.e.value('(action[@name="database_name"]/value)[1]','nvarchar(128)') AS db,
    x.e.value('(action[@name="client_app_name"]/value)[1]','nvarchar(256)') AS app,
    x.e.value('(action[@name="client_hostname"]/value)[1]','nvarchar(128)') AS host,
    x.e.value('(action[@name="username"]/value)[1]','nvarchar(128)') AS login,
    x.e.value('(action[@name="session_id"]/value)[1]','int') AS spid
  FROM (
    SELECT CAST(t.target_data AS xml) AS d
    FROM sys.dm_xe_session_targets t
    JOIN sys.dm_xe_sessions s ON s.address = t.event_session_address
    WHERE s.name = @name AND t.target_name = 'ring_buffer'
  ) q
  CROSS APPLY q.d.nodes('RingBufferTarget/event') x(e)
) ev
WHERE ev.seq > @last
ORDER BY ev.seq;`;

function render(r) {
  if (opts.json) {
    console.log(JSON.stringify({
      time: r.ts, event: r.event, db: r.db, sp: r.obj, spid: r.spid, login: r.login, host: r.host, app: r.app,
      duration_ms: r.duration_us == null ? null : r.duration_us / 1000, cpu_ms: r.cpu_us == null ? null : r.cpu_us / 1000,
      reads: r.reads == null ? null : Number(r.reads), writes: r.writes == null ? null : Number(r.writes), rows: r.rows == null ? null : Number(r.rows), result: r.result, nest: r.nest, line: r.line, error: r.errno, severity: r.sev, text: r.msg || r.stmt || r.batch,
    }));
    return;
  }
  const d = new Date(r.ts.getTime()); // XE entrega UTC; se muestra en hora local
  const t = d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0');
  if (r.event === 'error_reported') {
    console.log(`${C.d}${t}${C.x} ${C.r}ERR  ${C.b}#${r.errno} sev=${r.sev}${C.x} ${C.r}${(r.msg || '').trim()}${C.x}\n${C.d}  ${r.db || ''} · spid ${r.spid} · ${r.login || ''}@${r.host || ''} · ${r.app || ''}${C.x}`);
    return;
  }
  const bad = r.result && r.result !== 'OK';
  const kind = { rpc_completed: 'RPC', sp_statement_completed: 'STMT', sql_batch_completed: 'BATCH' }[r.event] || r.event;
  const dur = r.duration_us == null ? '' : `${(r.duration_us / 1000).toFixed(1)}ms`;
  const meta = [
    dur && `dur=${dur}`,
    r.cpu_us != null && `cpu=${(r.cpu_us / 1000).toFixed(1)}ms`,
    r.reads != null && `reads=${r.reads}`,
    r.event === 'sp_statement_completed' && `nest=${r.nest} line=${r.line}`,
    r.rows != null && r.rows >= 0 && `rows=${r.rows}`,
  ].filter(Boolean).join(' ');
  const head = `${C.d}${t}${C.x} ${bad ? C.r : C.g}${kind.padEnd(5)}${C.x} ${C.b}${r.obj || ''}${C.x}` +
    (bad ? ` ${C.r}[${r.result}]${C.x}` : '') + ` ${C.y}${meta}${C.x}`;
  const who = `${C.d}  ${r.db || ''} · spid ${r.spid} · ${r.login || ''}@${r.host || ''} · ${r.app || ''}${C.x}`;
  const body = (r.stmt || r.batch || '').trim().replace(/\s*\n\s*/g, ' ');
  console.log(head + '\n' + who + (body ? `\n  ${C.c}${body.length > 600 ? body.slice(0, 600) + '…' : body}${C.x}` : ''));
}

async function clean() {
  const res = await pool.request().query(`SELECT name FROM sys.server_event_sessions WHERE name LIKE 'exprof[_]%'`);
  for (const { name } of res.recordset) {
    await pool.request().query(`DROP EVENT SESSION [${name}] ON SERVER`);
    console.log(`Eliminada ${name}`);
  }
  if (!res.recordset.length) console.log('No hay sesiones exprof_* huerfanas.');
}

async function main() {
  const patterns = [...(opts.sp || []), ...positionals];
  if (!patterns.length && !opts.all && !opts.clean) {
    console.error('Indica al menos un SP a escuchar (ej: exprof usp_MiProc) o usa --all.\n');
    console.error(HELP);
    process.exit(2);
  }

  await pool.connect();
  if (opts.clean) { await clean(); return pool.close(); }

  const name = `exprof_${process.pid}_${Date.now().toString(36)}`;
  await pool.request().batch(buildSession(name, patterns));
  await pool.request().batch(`ALTER EVENT SESSION [${name}] ON SERVER STATE = START`);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await pool.request().batch(`IF EXISTS (SELECT 1 FROM sys.server_event_sessions WHERE name='${name}') DROP EVENT SESSION [${name}] ON SERVER`);
      await pool.close();
    } catch { /* al salir no importa */ }
    console.error(`\n${C.d}Sesion ${name} eliminada.${C.x}`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  console.error(`${C.d}${usedEnv.length ? 'env: ' + usedEnv[0] + ' · ' : ''}Escuchando en ${cfg.server}${opts.db ? ` [${opts.db}]` : ''} · filtro: ${patterns.length ? patterns.join(', ') : '(todos)'} · Ctrl+C para salir${C.x}\n`);

  let last = 0;
  const every = Math.max(200, Number(opts.interval) || 1000);
  while (!stopping) {
    try {
      const res = await pool.request()
        .input('name', sql.NVarChar(128), name)
        .input('last', sql.BigInt, last)
        .query(READ_SQL);
      for (const r of res.recordset) { render(r); last = Math.max(last, Number(r.seq)); }
    } catch (e) {
      console.error(`${C.r}poll: ${e.message}${C.x}`);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}

main().catch((e) => {
  const hint = /permission|denied/i.test(e.message) ? '\nNecesitas ALTER ANY EVENT SESSION y VIEW SERVER STATE (GRANT ... TO [login]).' : '';
  console.error(`${C.r}Error: ${e.message}${C.x}${hint}`);
  process.exit(1);
});
